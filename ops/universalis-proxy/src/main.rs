//! 极小的 Universalis 反向代理：只放行行情相关路径，其余 404。
//!
//! 关键行为：
//! - 上游连接复用（reqwest 连接池，TLS 走 ALPN，能协商到 h2），避免每次重付 TLS 握手；
//! - 进程内缓存，TTL 取上游 `Cache-Control: max-age` 并夹到安全区间；
//! - 只缓存 2xx；命中与未命中都用 `x-proxy-cache` 标出来，方便压测与线上排查。
//!
//! 子命令 `bench` 用同一套 HTTP 客户端压测任意 URL（本服务或上游直连），
//! 保证"代理 vs 直连"的对比是同一个栈。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use bytes::Bytes;
use tokio::net::TcpListener;

const HIT: &str = "hit";
const MISS: &str = "miss";
const MAX_UPSTREAM_TTL: Duration = Duration::from_secs(600);
const MIN_UPSTREAM_TTL: Duration = Duration::from_secs(30);
const ALLOWED_ORIGINS: &[&str] = &[
    "https://market.icexiv.top",
    "https://market-stage.icexiv.top",
];

struct App {
    client: reqwest::Client,
    upstream: String,
    cache: std::sync::RwLock<Cache>,
    /// 同一个 key 并发未命中时只打一次上游，其余请求等第一个结果
    inflight: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 上游出站限速：Universalis 文档给的是 25 req/s（突发 50）、每 IP 最多 8 条连接
    limiter: Limiter,
    /// 入站按 IP 限速，防止单 IP 刷爆上游额度
    ip_limiter: IpLimiter,
    stats: Stats,
    default_ttl: Duration,
    marketable_ttl: Duration,
}

struct IpLimiter {
    buckets: std::sync::Mutex<HashMap<String, (f64, Instant)>>,
    rate: f64,
    burst: f64,
}

impl IpLimiter {
    fn new(rate: f64, burst: f64) -> Self {
        Self {
            buckets: std::sync::Mutex::new(HashMap::new()),
            rate,
            burst,
        }
    }

    fn check(&self, ip: &str) -> bool {
        let mut buckets = self.buckets.lock().unwrap();
        let now = Instant::now();
        if buckets.len() > 10_000 {
            buckets.retain(|_, (_, last)| now.saturating_duration_since(*last) < Duration::from_secs(60));
        }
        let entry = buckets.entry(ip.to_owned()).or_insert((self.burst, now));
        let elapsed = now.saturating_duration_since(entry.1).as_secs_f64();
        entry.0 = (entry.0 + elapsed * self.rate).min(self.burst);
        entry.1 = now;
        if entry.0 >= 1.0 {
            entry.0 -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
struct Stats {
    hits: AtomicU64,
    shared: AtomicU64,
    misses: AtomicU64,
    stale: AtomicU64,
    cooldown: AtomicU64,
    errors: AtomicU64,
    too_many_requests: AtomicU64,
}

/// 令牌桶 + 429 冷却。
/// 命中不走这里，所以实际出站请求量只由未命中决定；桶负责把突发压到文档的上限以下。
struct Limiter {
    inner: std::sync::Mutex<Bucket>,
    rate: f64,
    burst: f64,
}

struct Bucket {
    tokens: f64,
    last: Instant,
    cooldown_until: Option<Instant>,
    consecutive_429: u32,
}

enum Gate {
    Ready,
    /// 上游正在 429 冷却期，别再去撞
    Cooling(Duration),
    /// 排队超时（上游被限速或很慢）
    Timeout,
}

impl Limiter {
    fn new(rate: f64, burst: f64) -> Self {
        Self {
            inner: std::sync::Mutex::new(Bucket {
                tokens: burst,
                last: Instant::now(),
                cooldown_until: None,
                consecutive_429: 0,
            }),
            rate,
            burst,
        }
    }

    async fn acquire(&self, max_wait: Duration) -> Gate {
        let deadline = Instant::now() + max_wait;
        loop {
            let wait = {
                let mut bucket = self.inner.lock().unwrap();
                let now = Instant::now();
                if let Some(until) = bucket.cooldown_until {
                    if until > now {
                        return Gate::Cooling(until - now);
                    }
                    bucket.cooldown_until = None;
                }
                let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
                bucket.tokens = (bucket.tokens + elapsed * self.rate).min(self.burst);
                bucket.last = now;
                if bucket.tokens >= 1.0 {
                    bucket.tokens -= 1.0;
                    return Gate::Ready;
                }
                Duration::from_secs_f64((1.0 - bucket.tokens) / self.rate)
            };
            if Instant::now() + wait > deadline {
                return Gate::Timeout;
            }
            tokio::time::sleep(wait).await;
        }
    }

    /// 429 后进入冷却；连续撞墙时间递增，最长 8 s。
    /// 同一批并发请求会一起收到 429，已经在冷却就不重复叠加。
    fn penalize(&self, retry_after: Option<Duration>) {
        let mut bucket = self.inner.lock().unwrap();
        let now = Instant::now();
        if bucket.cooldown_until.is_some_and(|until| until > now) {
            return;
        }
        bucket.consecutive_429 = bucket.consecutive_429.saturating_add(1);
        let backoff = retry_after
            .unwrap_or_else(|| Duration::from_millis(500 * 2u64.pow(bucket.consecutive_429.min(4))))
            .min(Duration::from_secs(8));
        bucket.cooldown_until = Some(now + backoff);
    }

    fn reward(&self) {
        self.inner.lock().unwrap().consecutive_429 = 0;
    }
}

struct Entry {
    status: u16,
    content_type: Option<HeaderValue>,
    body: Bytes,
    stored: Instant,
    expires: Instant,
    ttl: Duration,
}

struct Cache {
    map: HashMap<String, Entry>,
    order: VecDeque<String>,
    bytes: usize,
    max_bytes: usize,
    max_entries: usize,
}

impl Cache {
    fn new(max_bytes: usize, max_entries: usize) -> Self {
        Self { map: HashMap::new(), order: VecDeque::new(), bytes: 0, max_bytes, max_entries }
    }

    fn get(&self, key: &str) -> Option<&Entry> {
        self.map.get(key).filter(|entry| entry.expires > Instant::now())
    }

    /// 忽略过期时间取缓存：上游失败时用它兜底，避免用户看到 502
    fn get_stale(&self, key: &str) -> Option<&Entry> {
        self.map.get(key)
    }

    fn insert(&mut self, key: String, entry: Entry) {
        let size = entry.body.len();
        let already = self.map.contains_key(&key);
        if let Some(old) = self.map.remove(&key) {
            self.bytes = self.bytes.saturating_sub(old.body.len());
        }
        self.bytes += size;
        self.map.insert(key.clone(), entry);
        if !already {
            self.order.push_back(key);
        }
        // FIFO 淘汰；条目过期后不主动清理，插入时顺带丢掉最旧的，够用且简单
        while (self.bytes > self.max_bytes || self.map.len() > self.max_entries) && !self.order.is_empty() {
            let victim = self.order.pop_front().unwrap();
            if let Some(entry) = self.map.remove(&victim) {
                self.bytes = self.bytes.saturating_sub(entry.body.len());
            }
        }
    }
}

fn env_secs(key: &str, default: u64) -> Duration {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).map(Duration::from_secs).unwrap_or(Duration::from_secs(default))
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// 只允许行情相关的 GET 路径，避免被当成通用代理滥用。
fn is_allowed(path: &str) -> bool {
    if matches!(path, "/api/v2/marketable" | "/api/v2/data-centers" | "/api/v2/worlds") {
        return true;
    }
    if path.starts_with("/api/v2/aggregated/") || path.starts_with("/api/v2/history/") {
        return true;
    }
    // /api/v2/<world|dc|region>/<itemId,itemId,...>
    let rest = match path.strip_prefix("/api/v2/") {
        Some(rest) => rest,
        None => return false,
    };
    let mut parts = rest.split('/');
    let scope = parts.next().unwrap_or_default();
    let ids = parts.next().unwrap_or_default();
    !scope.is_empty() && parts.next().is_none() && !ids.is_empty()
        && ids.chars().all(|c| c.is_ascii_digit() || c == ',')
}

fn parse_max_age(cache_control: Option<&str>) -> Option<Duration> {
    let value = cache_control?;
    value.split(',').find_map(|part| {
        let part = part.trim();
        let rest = part.strip_prefix("max-age=")?;
        rest.parse::<u64>().ok().map(Duration::from_secs)
    })
}

fn ttl_for(app: &App, path: &str, cache_control: Option<&str>) -> Duration {
    if matches!(path, "/api/v2/data-centers" | "/api/v2/worlds") {
        return Duration::from_secs(24 * 60 * 60);
    }
    if path == "/api/v2/marketable" {
        return app.marketable_ttl;
    }
    parse_max_age(cache_control)
        .unwrap_or(app.default_ttl)
        .clamp(MIN_UPSTREAM_TTL, MAX_UPSTREAM_TTL)
}

/// 只保留白名单查询参数（目前只有 history 的 entriesWithin），避免随机 query 穿透缓存。
fn normalize_key(path: &str, query: Option<&str>) -> String {
    if path.starts_with("/api/v2/history/") {
        if let Some(q) = query {
            for pair in q.split('&') {
                if let Some(val) = pair.strip_prefix("entriesWithin=") {
                    if !val.is_empty() && val.chars().all(|c| c.is_ascii_digit()) {
                        return format!("{path}?entriesWithin={val}");
                    }
                }
            }
        }
    }
    path.to_owned()
}

fn build_response(entry: &Entry, cache: &str, age: Option<Duration>, origin: Option<&str>) -> Response {
    let stale = cache == "stale";
    let max_age = if stale {
        30
    } else {
        entry.expires.saturating_duration_since(Instant::now()).as_secs()
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(entry.status).unwrap_or(StatusCode::OK))
        .header(header::CACHE_CONTROL, format!("public, max-age={max_age}"))
        .header("x-proxy-cache", cache);
    if let Some(origin) = origin {
        builder = builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::VARY, "Origin");
    }
    if let Some(content_type) = &entry.content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type.clone());
    }
    if let Some(age) = age {
        builder = builder.header(header::AGE, age.as_secs().to_string());
    }
    if stale {
        builder = builder.header(header::WARNING, "110 - \"Response is Stale\"");
    }
    builder.body(Body::from(entry.body.clone())).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

struct FetchError {
    status: Option<u16>,
    retry_after: Option<Duration>,
    message: String,
}

fn parse_retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
}

async fn fetch(app: &App, path_and_query: &str) -> Result<Entry, FetchError> {
    let url = format!("{}{}", app.upstream, path_and_query);
    // 不要自己塞 CF-Connecting-IP：那是 Cloudflare 的保留头，客户端伪造会被直接 403
    let request = app.client.get(&url).timeout(Duration::from_secs(10));
    let response = request.send().await.map_err(|e| FetchError {
        status: None,
        retry_after: None,
        message: format!("upstream: {e}"),
    })?;

    let status = response.status();
    if !status.is_success() {
        return Err(FetchError {
            status: Some(status.as_u16()),
            retry_after: parse_retry_after(&response),
            message: format!("upstream status {}", status.as_u16()),
        });
    }
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    let cache_control = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.bytes().await.map_err(|e| FetchError {
        status: None,
        retry_after: None,
        message: format!("body: {e}"),
    })?;
    // 用请求路径（不含查询串）判断 TTL；max-age 取上游，缺失时用默认值
    let path = path_and_query.split('?').next().unwrap_or("");
    let ttl = ttl_for(app, path, cache_control.as_deref());
    let now = Instant::now();
    Ok(Entry {
        status: status.as_u16(),
        content_type,
        body,
        stored: now,
        expires: now + ttl,
        ttl,
    })
}

fn stale_or_error(app: &App, key: &str, error: &FetchError, started: Instant, method: &Method, status: StatusCode, origin: Option<&str>) -> Response {
    let stale = app.cache.read().unwrap().get_stale(key).map(|entry| {
        let age = entry.stored.elapsed();
        (build_response(entry, "stale", Some(age), origin), entry.body.len())
    });
    match stale {
        Some((response, size)) => {
            app.stats.stale.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "{} {} cache=stale {:?} {}B after {}",
                method,
                key,
                started.elapsed(),
                size,
                error.message
            );
            response
        }
        None => {
            app.stats.errors.fetch_add(1, Ordering::Relaxed);
            eprintln!("{} {} upstream-error {:?} {}", method, key, started.elapsed(), error.message);
            let mut response = (status, error.message.clone()).into_response();
            if let Some(retry_after) = error.retry_after {
                if let Ok(value) = HeaderValue::from_str(&retry_after.as_secs().to_string()) {
                    response.headers_mut().insert(header::RETRY_AFTER, value);
                }
            }
            response
        }
    }
}

async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let path = uri.path().to_owned();
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|o| ALLOWED_ORIGINS.contains(o))
        .map(str::to_owned);
    let client_ip = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("direct")
        .to_owned();

    if method != Method::GET && method != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "only GET/HEAD").into_response();
    }
    if path == "/healthz" {
        return (StatusCode::OK, "ok").into_response();
    }
    if path == "/stats" {
        return stats_response(&app);
    }
    if !is_allowed(&path) {
        return (StatusCode::NOT_FOUND, "not proxied").into_response();
    }
    if !app.ip_limiter.check(&client_ip) {
        return (StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded").into_response();
    }

    let key = normalize_key(&path, uri.query());
    let started = Instant::now();

    if let Some(entry) = app.cache.read().unwrap().get(&key) {
        let age = entry.stored.elapsed();
        app.stats.hits.fetch_add(1, Ordering::Relaxed);
        let response = build_response(entry, HIT, Some(age), origin.as_deref());
        eprintln!(
            "{} {} cache=hit {:?} {}B ttl={}s",
            method,
            key,
            started.elapsed(),
            entry.body.len(),
            entry.ttl.as_secs()
        );
        return response;
    }

    // 未命中：同一个 key 只允许一个请求打上游，其余等它写回缓存。
    // 上游在高峰期会卡到 10 s 以上，并发同一物品的请求没必要各自开一次。
    let request_lock = {
        let mut inflight = app.inflight.lock().unwrap();
        inflight
            .entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = request_lock.lock().await;

    // 等到锁的请求先看缓存：leader 可能已经写好了
    if let Some(entry) = app.cache.read().unwrap().get(&key) {
        let age = entry.stored.elapsed();
        app.stats.shared.fetch_add(1, Ordering::Relaxed);
        let response = build_response(entry, HIT, Some(age), origin.as_deref());
        eprintln!("{} {} cache=shared {:?} {}B", method, key, started.elapsed(), entry.body.len());
        return response;
    }

    // 出站限速：命中不经过这里，只有真正要打上游的请求才排队
    let mut gate = app.limiter.acquire(Duration::from_secs(3)).await;
    // 冷却很短时宁可等过去，也不要把用户打成 503
    if let Gate::Cooling(wait) = gate {
        if wait <= Duration::from_secs(2) {
            tokio::time::sleep(wait).await;
            gate = app.limiter.acquire(Duration::from_secs(2)).await;
        }
    }
    let gate_error = match gate {
        Gate::Ready => None,
        Gate::Cooling(wait) => Some(FetchError {
            status: Some(429),
            retry_after: Some(wait),
            message: format!("upstream cooling after 429 ({} ms left)", wait.as_millis()),
        }),
        Gate::Timeout => Some(FetchError {
            status: None,
            retry_after: Some(Duration::from_secs(1)),
            message: "upstream queue timeout".to_owned(),
        }),
    };
    if let Some(error) = gate_error {
        app.stats.cooldown.fetch_add(1, Ordering::Relaxed);
        app.inflight.lock().unwrap().remove(&key);
        return stale_or_error(&app, &key, &error, started, &method, StatusCode::SERVICE_UNAVAILABLE, origin.as_deref());
    }

    let mut attempt = fetch(&app, &key).await;
    // 偶发 429 先按 Retry-After 等一次再重试；真正的持续限流交给下面的冷却
    if let Err(error) = &attempt {
        if error.status == Some(429) {
            let wait = error.retry_after.unwrap_or(Duration::from_millis(500)).min(Duration::from_secs(2));
            tokio::time::sleep(wait).await;
            attempt = fetch(&app, &key).await;
        }
    }

    match attempt {
        Ok(entry) => {
            app.limiter.reward();
            app.stats.misses.fetch_add(1, Ordering::Relaxed);
            let response = build_response(&entry, MISS, None, origin.as_deref());
            let (ttl, size) = (entry.ttl, entry.body.len());
            eprintln!("{} {} cache=miss {:?} {}B ttl={}s", method, key, started.elapsed(), size, ttl.as_secs());
            app.cache.write().unwrap().insert(key.clone(), entry);
            app.inflight.lock().unwrap().remove(&key);
            response
        }
        Err(error) => {
            if error.status == Some(429) {
                app.stats.too_many_requests.fetch_add(1, Ordering::Relaxed);
                app.limiter.penalize(error.retry_after);
            }
            app.inflight.lock().unwrap().remove(&key);
            // 上游失败时回退到过期副本：宁可给旧行情，也不要整页 502
            let status = if error.status == Some(429) { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::BAD_GATEWAY };
            stale_or_error(&app, &key, &error, started, &method, status, origin.as_deref())
        }
    }
}

fn stats_response(app: &App) -> Response {
    let cache = app.cache.read().unwrap();
    let body = format!(
        "{{\"hits\":{},\"shared\":{},\"misses\":{},\"stale\":{},\"cooldown\":{},\"errors\":{},\"upstream_429\":{},\"cache_entries\":{},\"cache_bytes\":{}}}",
        app.stats.hits.load(Ordering::Relaxed),
        app.stats.shared.load(Ordering::Relaxed),
        app.stats.misses.load(Ordering::Relaxed),
        app.stats.stale.load(Ordering::Relaxed),
        app.stats.cooldown.load(Ordering::Relaxed),
        app.stats.errors.load(Ordering::Relaxed),
        app.stats.too_many_requests.load(Ordering::Relaxed),
        cache.map.len(),
        cache.bytes
    );
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let listen = std::env::var("LISTEN").unwrap_or_else(|_| "127.0.0.1:18090".to_owned());
    let upstream = std::env::var("UPSTREAM").unwrap_or_else(|_| "https://universalis.app".to_owned());
    let max_bytes = env_usize("CACHE_MAX_MB", 64) * 1024 * 1024;
    let max_entries = env_usize("CACHE_MAX_ENTRIES", 20_000);

    let client = reqwest::Client::builder()
        // 上游文档要求每 IP 最多 8 条连接；h2 会在一条连接上复用，留 2 条足够
        .pool_max_idle_per_host(2)
        .tcp_keepalive(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .user_agent("xiv-market-proxy/0.1 (+https://github.com/AzurIce/xiv-market)")
        .build()?;

    let rps = std::env::var("UPSTREAM_RPS").ok().and_then(|v| v.parse().ok()).unwrap_or(8.0);
    let burst = std::env::var("UPSTREAM_BURST").ok().and_then(|v| v.parse().ok()).unwrap_or(8.0);
    let ip_rps = std::env::var("IP_RPS").ok().and_then(|v| v.parse().ok()).unwrap_or(5.0);
    let ip_burst = std::env::var("IP_BURST").ok().and_then(|v| v.parse().ok()).unwrap_or(20.0);

    let app = Arc::new(App {
        client,
        upstream,
        cache: std::sync::RwLock::new(Cache::new(max_bytes, max_entries)),
        inflight: std::sync::Mutex::new(HashMap::new()),
        limiter: Limiter::new(rps, burst),
        ip_limiter: IpLimiter::new(ip_rps, ip_burst),
        stats: Stats::default(),
        default_ttl: env_secs("DEFAULT_TTL", 300),
        marketable_ttl: env_secs("MARKETABLE_TTL", 3600),
    });

    let router = Router::new().fallback(handle).with_state(app.clone());
    let listener = TcpListener::bind(&listen).await?;
    eprintln!(
        "universalis-proxy listening on {listen} -> {} (cache {} MiB, default ttl {}s, marketable ttl {}s)",
        app.upstream,
        max_bytes / 1024 / 1024,
        app.default_ttl.as_secs(),
        app.marketable_ttl.as_secs()
    );
    axum::serve(listener, router).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

fn percentile(sorted: &[Duration], ratio: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let index = ((sorted.len() - 1) as f64 * ratio).round() as usize;
    sorted[index]
}

async fn bench(url: &str, total: usize, concurrency: usize, bust: bool) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(concurrency.max(4))
        .tcp_keepalive(Duration::from_secs(30))
        .build()?;
    let per_worker = total.div_ceil(concurrency);
    let started = Instant::now();
    let bust_separator = if url.contains('?') { '&' } else { '?' };

    let mut workers = tokio::task::JoinSet::new();
    for worker in 0..concurrency {
        let client = client.clone();
        let url = url.to_owned();
        let mut latencies = Vec::with_capacity(per_worker);
        workers.spawn(async move {
            let mut errors = 0usize;
            let mut bytes = 0usize;
            for index in 0..per_worker {
                // --bust：每个请求带不同查询参数，强制缓存未命中，用来量"最差情况"
                let request_url = if bust {
                    format!("{url}{bust_separator}_={worker}x{index}")
                } else {
                    url.clone()
                };
                let request_started = Instant::now();
                match client.get(&request_url).send().await {
                    Ok(response) if response.status().is_success() => {
                        match response.bytes().await {
                            Ok(body) => bytes += body.len(),
                            Err(_) => errors += 1,
                        }
                    }
                    Ok(_) => errors += 1,
                    Err(_) => errors += 1,
                }
                latencies.push(request_started.elapsed());
            }
            (latencies, errors, bytes)
        });
    }

    let mut latencies = Vec::with_capacity(total);
    let mut errors = 0usize;
    let mut bytes = 0usize;
    while let Some(result) = workers.join_next().await {
        if let Ok((worker_latencies, worker_errors, worker_bytes)) = result {
            latencies.extend(worker_latencies);
            errors += worker_errors;
            bytes += worker_bytes;
        }
    }
    let elapsed = started.elapsed();
    latencies.sort();
    let mean = latencies.iter().map(|d| d.as_secs_f64()).sum::<f64>() / latencies.len().max(1) as f64;
    println!(
        "n={} concurrency={} ok={} err={} {} bytes in {:.2}s = {:.0} req/s\n  mean {:.1}ms  p50 {:.1}ms  p90 {:.1}ms  p99 {:.1}ms  max {:.1}ms",
        latencies.len(),
        concurrency,
        latencies.len() - errors,
        errors,
        bytes,
        elapsed.as_secs_f64(),
        latencies.len() as f64 / elapsed.as_secs_f64(),
        mean * 1000.0,
        percentile(&latencies, 0.50).as_secs_f64() * 1000.0,
        percentile(&latencies, 0.90).as_secs_f64() * 1000.0,
        percentile(&latencies, 0.99).as_secs_f64() * 1000.0,
        latencies.last().copied().unwrap_or_default().as_secs_f64() * 1000.0
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("bench") {
        let url = args.get(2).cloned().unwrap_or_else(|| {
            eprintln!("usage: universalis-proxy bench <url> [n] [concurrency]");
            std::process::exit(2);
        });
        let total = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(200);
        let concurrency = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(8);
        let bust = args.iter().any(|arg| arg == "--bust");
        return bench(&url, total, concurrency, bust).await;
    }
    serve().await
}
