/*
 * YF Ticker — yfticker@kahsky
 *
 * Modern horizontal scrolling stock ticker using Yahoo Finance data.
 * Based on networking code from yfquotes@thegli (thegli).
 */

const Desklet  = imports.ui.desklet;
const St       = imports.gi.St;
const Gio      = imports.gi.Gio;
const GLib     = imports.gi.GLib;
const Soup     = imports.gi.Soup;
const ByteArray = imports.byteArray;
const Settings = imports.ui.settings;
const Gettext  = imports.gettext;
const { spawnCommandLineAsyncIO } = require("./lib/util-extract");

const UUID        = "yfticker@kahsky";
const DESKLET_DIR = imports.ui.deskletManager.deskletMeta[UUID].path;
const LOG_DEBUG   = Gio.file_new_for_path(DESKLET_DIR + "/DEBUG").query_exists(null);
const IS_SOUP_2   = Soup.MAJOR_VERSION === 2;

const YF_COOKIE_URL      = "https://finance.yahoo.com/quote/%5EGSPC/options";
const YF_CONSENT_URL     = "https://consent.yahoo.com/v2/collectConsent";
const YF_CRUMB_URL       = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const YF_QUOTE_URL       = "https://query1.finance.yahoo.com/v7/finance/quote";
const YF_QUOTE_FIELDS    = "symbol,shortName,currency,marketState,hasPrePostMarketData,"
    + "regularMarketPrice,regularMarketChange,regularMarketChangePercent";

const ACCEPT_HEADER          = "Accept";
const ACCEPT_VALUE_COOKIE    = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ACCEPT_VALUE_CRUMB     = "*/*";
const ACCEPT_ENCODING_HEADER = "Accept-Encoding";
const ACCEPT_ENCODING_VALUE  = "gzip, deflate";
const USER_AGENT_HEADER      = "User-Agent";
const FORM_URLENCODED_VALUE  = "application/x-www-form-urlencoded";

const AUTH_COOKIE   = "A1";
const CONSENT_COOKIE = "GUCS";

const CACHED_AUTH_PARAMS_VERSION  = 1;
const DEFAULT_CACHED_AUTH_PARAMS  = "{\"version\": " + CACHED_AUTH_PARAMS_VERSION + "}";

const CURL_SILENT_LOCATION_OPTIONS  = "-sSL";
const CURL_CONNECT_TIMEOUT_OPTION   = "--connect-timeout";
const CURL_CONNECT_TIMEOUT_VALUE    = "5";
const CURL_MAX_TIME_OPTION          = "-m";
const CURL_MAX_TIME_VALUE           = "15";
const CURL_WRITE_OUT_OPTION         = "-w";
const CURL_RESPONSE_CODE_PREFIX     = "HTTP_CODE=";
const CURL_WRITE_OUT_VALUE          = CURL_RESPONSE_CODE_PREFIX + "%{http_code}";
const CURL_HEADER_OPTION            = "-H";
const CURL_COOKIE_HEADER_NAME       = "Cookie: ";
const CURL_USER_AGENT_HEADER_NAME   = "User-Agent: ";
const CURL_CIPHERS_OPTION           = "--ciphers";
const CURL_CIPHERS_VALUE =
    "TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256," +
    "ECDHE-ECDSA-AES128-GCM-SHA256,ECDHE-RSA-AES128-GCM-SHA256," +
    "ECDHE-ECDSA-AES256-GCM-SHA384,ECDHE-RSA-AES256-GCM-SHA384," +
    "ECDHE-ECDSA-CHACHA20-POLY1305,ECDHE-RSA-CHACHA20-POLY1305";

const MAX_AUTH_ATTEMPTS = 3;
const BASE_FONT_SIZE    = 12;
const SCROLL_INTERVAL_MS = 16; // ~60fps
const ABSENT = "N/A";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");
function _(str) { return Gettext.dgettext(UUID, str); }

// ---------------------------------------------------------------------------
// CurlMessage — mimics libsoup SoupMessage for curl responses
// ---------------------------------------------------------------------------
function CurlMessage(response) { this.init(response); }
CurlMessage.prototype = {
    init(response) {
        const parts = response.split(CURL_RESPONSE_CODE_PREFIX);
        this.response_body = parts[0];
        this.status_code   = Number(parts[1]);
        this.reason_phrase = this._phrase(this.status_code);
    },
    _phrase(code) {
        const map = {200:"OK",400:"Bad Request",401:"Unauthorized",403:"Forbidden",
            404:"Not Found",429:"Too Many Requests",500:"Internal Server Error",
            502:"Bad Gateway",503:"Service Unavailable",504:"Gateway Timeout"};
        return map[code] || "Unknown reason";
    },
    get_reason_phrase() { return this.reason_phrase; },
    get_status()        { return this.status_code; }
};

// ---------------------------------------------------------------------------
// YFUtils — logging & shared helpers
// ---------------------------------------------------------------------------
function YFUtils(id) { this.id = id; }
YFUtils.prototype = {
    _log(fn, msg) { fn(`${UUID}[${this.id}] ${msg}`); },
    debug(msg)    { if (LOG_DEBUG) global.log(`${UUID}[${this.id}] DEBUG ${msg}`); },
    info(msg)     { global.log(`${UUID}[${this.id}] ${msg}`); },
    warn(msg)     { global.logWarning(`${UUID}[${this.id}] ${msg}`); },
    error(msg)    { global.logError(`${UUID}[${this.id}] ${msg}`); },
    ex(ctx, err)  {
        const d = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : err;
        global.logError(`${UUID}[${this.id}] ${ctx}\n${d}`);
    },
    has(obj, prop) {
        return obj.hasOwnProperty(prop) && typeof obj[prop] !== "undefined" && obj[prop] !== null;
    },
    buildSymbolsArg(text) {
        return text.split("\n").map(l => l.trim()).filter(l => l !== "")
                   .map(l => l.split(";")[0].toUpperCase()).join();
    },
    compareSymbolsArg(arg, text) { return arg === this.buildSymbolsArg(text); },
    isOk(msg) {
        if (!msg) return false;
        return IS_SOUP_2 ? msg.status_code === Soup.KnownStatusCode.OK
                         : msg.get_reason_phrase() === "OK";
    },
    isUnauthorized(msg) {
        if (!msg) return false;
        return IS_SOUP_2 ? msg.status_code === Soup.KnownStatusCode.UNAUTHORIZED
                         : msg.get_reason_phrase() === "Unauthorized";
    },
    statusInfo(msg) {
        if (!msg) return "no status";
        if (IS_SOUP_2) return msg.status_code + " " + msg.reason_phrase;
        let reason = msg.get_reason_phrase(), status = "?";
        try { status = msg.get_status(); } catch (e) {
            if (e.message.indexOf("429") > -1) { status = "429"; reason = "Too Many Requests"; }
        }
        return status + " " + reason;
    },
    roundAmt(val, decimals, strict) {
        if (decimals < 0) return val;
        if (strict) return val.toFixed(decimals);
        const parts = val.toString().split(".");
        if (parts.length > 1 && parts[1].length > decimals) return Number(val.toFixed(decimals));
        return val;
    }
};

// ---------------------------------------------------------------------------
// YFReader — fetches quotes from Yahoo Finance
// ---------------------------------------------------------------------------
function YFReader(id) { this.init(id); }
YFReader.prototype = {
    init(id) {
        this.id = id;
        this.utils = new YFUtils(id);
        let sess;
        if (IS_SOUP_2) {
            sess = new Soup.SessionAsync();
            Soup.Session.prototype.add_feature.call(sess, new Soup.ProxyResolverDefault());
            Soup.Session.prototype.add_feature.call(sess, new Soup.ContentDecoder());
        } else {
            sess = new Soup.Session();
        }
        sess.timeout = 10; sess.idle_timeout = 10;
        const jar = new Soup.CookieJar();
        Soup.Session.prototype.add_feature.call(sess, jar);
        this.session = sess;
        this.jar = jar;
        this.auth = { cookie: null, crumb: null };
    },

    // --- crumb/cookie helpers ---
    setCrumb(v)  { this.auth.crumb  = v; },
    hasCrumb()   { return this.auth.crumb != null; },
    getCrumb()   { return this.auth.crumb; },
    setCookie(v) { this.auth.cookie = AUTH_COOKIE + "=" + v; },
    dropAuth()   { this._deleteAllCookies(); this.auth.cookie = null; this.auth.crumb = null; },

    // Read cookie from jar and store it so curl requests can use it
    setCookieFromJar(name) {
        const c = this._cookieFromJar(name);
        if (c) { this.setCookie(IS_SOUP_2 ? c.value : c.get_value()); return true; }
        return false;
    },

    _cookieFromJar(name) {
        for (const c of this.jar.all_cookies()) {
            const n = IS_SOUP_2 ? c.name : c.get_name();
            if (n === name) return c;
        }
        return null;
    },
    hasCookieInJar(name) { return this._cookieFromJar(name) != null; },
    _deleteAllCookies() {
        for (const c of this.jar.all_cookies()) this.jar.delete_cookie(c);
    },
    _addCookieToJar(p) {
        const c = new Soup.Cookie(p.name, p.value, p.domain, p.path, -1);
        if (p.expires > 0)
            c.set_expires(IS_SOUP_2 ? Soup.Date.new_from_time_t(p.expires) : GLib.DateTime.new_from_unix_utc(p.expires));
        this.jar.add_cookie(c);
    },

    // --- cache auth params ---
    prepareCache() {
        if (!this.hasCookieInJar(AUTH_COOKIE) || !this.hasCrumb()) return DEFAULT_CACHED_AUTH_PARAMS;
        const ac = this._cookieFromJar(AUTH_COOKIE);
        const exp = IS_SOUP_2 ? ac.expires : ac.get_expires();
        try {
            return JSON.stringify({ version: CACHED_AUTH_PARAMS_VERSION,
                cookie: { name: IS_SOUP_2?ac.name:ac.get_name(), value: IS_SOUP_2?ac.value:ac.get_value(),
                          domain: IS_SOUP_2?ac.domain:ac.get_domain(), path: IS_SOUP_2?ac.path:ac.get_path(),
                          expires: exp ? (IS_SOUP_2?exp.to_time_t():exp.to_unix()) : -1 },
                crumb: { value: this.getCrumb() }
            });
        } catch(e) { return DEFAULT_CACHED_AUTH_PARAMS; }
    },
    restoreCache(json) {
        let p;
        try { p = JSON.parse(json); } catch(e) { p = JSON.parse(DEFAULT_CACHED_AUTH_PARAMS); }
        if (p && this.utils.has(p,"version") && p.version === CACHED_AUTH_PARAMS_VERSION
            && this.utils.has(p,"cookie") && this.utils.has(p,"crumb")) {
            this.setCookie(p.cookie.value);
            this._addCookieToJar(p.cookie);
            this.setCrumb(p.crumb.value);
        }
    },

    // --- HTTP: cookie ---
    retrieveCookie(ua, cb) {
        IS_SOUP_2 ? this._cookieSoup2(ua, cb) : this._cookieSoup3(ua, cb);
    },
    _cookieSoup2(ua, cb) {
        const _t = this;
        const m = Soup.Message.new("GET", YF_COOKIE_URL);
        m.request_headers.append(ACCEPT_HEADER, ACCEPT_VALUE_COOKIE);
        m.request_headers.append(ACCEPT_ENCODING_HEADER, ACCEPT_ENCODING_VALUE);
        if (ua) m.request_headers.append(USER_AGENT_HEADER, ua);
        this.session.queue_message(m, (s, msg) => {
            if (_t.utils.isOk(msg)) {
                try { cb.call(_t, msg, msg.response_body.data); } catch(e) { _t.utils.ex("cookie soup2", e); }
            } else { cb.call(_t, msg, null); }
        });
    },
    _cookieSoup3(ua, cb) {
        const _t = this;
        const m = Soup.Message.new("GET", YF_COOKIE_URL);
        m.get_request_headers().append(ACCEPT_HEADER, ACCEPT_VALUE_COOKIE);
        m.get_request_headers().append(ACCEPT_ENCODING_HEADER, ACCEPT_ENCODING_VALUE);
        if (ua) m.get_request_headers().append(USER_AGENT_HEADER, ua);
        this.session.send_and_read_async(m, Soup.MessagePriority.NORMAL, null, (s, res) => {
            if (_t.utils.isOk(m)) {
                try { const b = s.send_and_read_finish(res); cb.call(_t, m, ByteArray.toString(b.get_data())); }
                catch(e) { _t.utils.ex("cookie soup3", e); }
            } else { cb.call(_t, m, null); }
        });
    },

    // --- HTTP: consent ---
    postConsent(ua, data, cb) {
        IS_SOUP_2 ? this._consentSoup2(ua, data, cb) : this._consentSoup3(ua, data, cb);
    },
    _consentSoup2(ua, data, cb) {
        const _t = this;
        const m = Soup.Message.new("POST", YF_CONSENT_URL);
        m.request_headers.append(ACCEPT_HEADER, ACCEPT_VALUE_COOKIE);
        m.request_headers.append(ACCEPT_ENCODING_HEADER, ACCEPT_ENCODING_VALUE);
        if (ua) m.request_headers.append(USER_AGENT_HEADER, ua);
        m.set_request(FORM_URLENCODED_VALUE, Soup.MemoryUse.COPY, data);
        this.session.queue_message(m, (s, msg) => {
            if (_t.utils.isOk(msg)) { try { cb.call(_t, msg); } catch(e) { _t.utils.ex("consent s2", e); } }
            else { cb.call(_t, msg); }
        });
    },
    _consentSoup3(ua, data, cb) {
        const _t = this;
        const m = Soup.Message.new("POST", YF_CONSENT_URL);
        m.get_request_headers().append(ACCEPT_HEADER, ACCEPT_VALUE_COOKIE);
        m.get_request_headers().append(ACCEPT_ENCODING_HEADER, ACCEPT_ENCODING_VALUE);
        if (ua) m.get_request_headers().append(USER_AGENT_HEADER, ua);
        const bytes = GLib.Bytes.new(ByteArray.fromString(data));
        m.set_request_body_from_bytes(FORM_URLENCODED_VALUE, bytes);
        this.session.send_and_read_async(m, Soup.MessagePriority.NORMAL, null, (s, res) => {
            try { s.send_and_read_finish(res); } catch(e) {}
            cb.call(_t, m);
        });
    },

    // --- HTTP: crumb ---
    retrieveCrumb(net, cb) {
        if (net.enableCurl) { this._crumbCurl(net, cb); return; }
        IS_SOUP_2 ? this._crumbSoup2(net.customUserAgent, cb) : this._crumbSoup3(net.customUserAgent, cb);
    },
    _crumbSoup2(ua, cb) {
        const _t = this;
        const m = Soup.Message.new("GET", YF_CRUMB_URL);
        m.request_headers.append(ACCEPT_HEADER, ACCEPT_VALUE_CRUMB);
        if (ua) m.request_headers.append(USER_AGENT_HEADER, ua);
        if (this.auth.cookie) m.request_headers.append("Cookie", this.auth.cookie);
        this.session.queue_message(m, (s, msg) => {
            if (_t.utils.isOk(msg)) { try { cb.call(_t, msg, msg.response_body); } catch(e) { _t.utils.ex("crumb s2", e); } }
            else { cb.call(_t, msg, null); }
        });
    },
    _crumbSoup3(ua, cb) {
        const _t = this;
        const m = Soup.Message.new("GET", YF_CRUMB_URL);
        m.get_request_headers().append(ACCEPT_HEADER, ACCEPT_VALUE_CRUMB);
        if (ua) m.get_request_headers().append(USER_AGENT_HEADER, ua);
        if (this.auth.cookie) m.get_request_headers().append("Cookie", this.auth.cookie);
        this.session.send_and_read_async(m, Soup.MessagePriority.NORMAL, null, (s, res) => {
            if (_t.utils.isOk(m)) {
                try { const b = s.send_and_read_finish(res); cb.call(_t, m, ByteArray.toString(b.get_data())); }
                catch(e) { _t.utils.ex("crumb s3", e); }
            } else { cb.call(_t, m, null); }
        });
    },
    _crumbCurl(net, cb) {
        const _t = this;
        const args = [net.curlCommand, CURL_SILENT_LOCATION_OPTIONS,
            CURL_CONNECT_TIMEOUT_OPTION, CURL_CONNECT_TIMEOUT_VALUE,
            CURL_MAX_TIME_OPTION, CURL_MAX_TIME_VALUE,
            CURL_WRITE_OUT_OPTION, CURL_WRITE_OUT_VALUE,
            CURL_CIPHERS_OPTION, CURL_CIPHERS_VALUE,
            CURL_HEADER_OPTION, ACCEPT_HEADER + ": " + ACCEPT_VALUE_CRUMB];
        if (net.customUserAgent) args.push(CURL_HEADER_OPTION, CURL_USER_AGENT_HEADER_NAME + net.customUserAgent);
        if (this.auth.cookie)   args.push(CURL_HEADER_OPTION, CURL_COOKIE_HEADER_NAME + this.auth.cookie);
        args.push(YF_CRUMB_URL);
        spawnCommandLineAsyncIO(null, (out, err, code) => {
            if (code === 0 && out) {
                const cm = new CurlMessage(out);
                if (_t.utils.isOk(cm)) cb.call(_t, cm, cm.response_body);
                else cb.call(_t, cm, null);
            } else { cb.call(_t, null, null); }
        }, { argv: args });
    },

    // --- HTTP: finance data ---
    retrieveFinanceData(symbolsArg, net, cb) {
        if (net.enableCurl) { this._financeCurl(symbolsArg, net, cb); return; }
        const url = this._buildUrl(symbolsArg);
        IS_SOUP_2 ? this._financeSoup2(url, net, cb) : this._financeSoup3(url, net, cb);
    },
    _buildUrl(symbolsArg) {
        return `${YF_QUOTE_URL}?lang=en-US&region=US&formatted=false&fields=${YF_QUOTE_FIELDS}&symbols=${encodeURIComponent(symbolsArg)}&crumb=${this.getCrumb()}`;
    },
    _financeSoup2(url, net, cb) {
        const _t = this;
        const m = Soup.Message.new("GET", url);
        if (net.customUserAgent) m.request_headers.append(USER_AGENT_HEADER, net.customUserAgent);
        this.session.queue_message(m, (s, msg) => {
            if (_t.utils.isOk(msg)) {
                try { cb.call(_t, msg.response_body.data.toString()); }
                catch(e) { _t.utils.ex("finance s2", e); }
            } else if (_t.utils.isUnauthorized(msg)) {
                _t.dropAuth(); cb.call(_t, _t._errResp("Auth expired"), false, true);
            } else { cb.call(_t, _t._errResp("YF unavailable: " + _t.utils.statusInfo(msg))); }
        });
    },
    _financeSoup3(url, net, cb) {
        const _t = this;
        const m = Soup.Message.new("GET", url);
        if (net.customUserAgent) m.get_request_headers().append(USER_AGENT_HEADER, net.customUserAgent);
        this.session.send_and_read_async(m, Soup.MessagePriority.NORMAL, null, (s, res) => {
            if (_t.utils.isOk(m)) {
                try { const b = s.send_and_read_finish(res); cb.call(_t, ByteArray.toString(b.get_data())); }
                catch(e) { _t.utils.ex("finance s3", e); }
            } else if (_t.utils.isUnauthorized(m)) {
                _t.dropAuth(); cb.call(_t, _t._errResp("Auth expired"), false, true);
            } else { cb.call(_t, _t._errResp("YF unavailable: " + _t.utils.statusInfo(m))); }
        });
    },
    _financeCurl(symbolsArg, net, cb) {
        const _t = this;
        const url = this._buildUrl(symbolsArg);
        const args = [net.curlCommand, CURL_SILENT_LOCATION_OPTIONS,
            CURL_CONNECT_TIMEOUT_OPTION, CURL_CONNECT_TIMEOUT_VALUE,
            CURL_MAX_TIME_OPTION, CURL_MAX_TIME_VALUE,
            CURL_WRITE_OUT_OPTION, CURL_WRITE_OUT_VALUE,
            CURL_CIPHERS_OPTION, CURL_CIPHERS_VALUE];
        if (net.customUserAgent) args.push(CURL_HEADER_OPTION, CURL_USER_AGENT_HEADER_NAME + net.customUserAgent);
        if (this.auth.cookie)   args.push(CURL_HEADER_OPTION, CURL_COOKIE_HEADER_NAME + this.auth.cookie);
        args.push(url);
        spawnCommandLineAsyncIO(null, (out, err, code) => {
            if (code === 0 && out) {
                const cm = new CurlMessage(out);
                if (_t.utils.isOk(cm)) cb.call(_t, cm.response_body);
                else if (_t.utils.isUnauthorized(cm)) { _t.dropAuth(); cb.call(_t, _t._errResp("Auth expired"), false, true); }
                else cb.call(_t, _t._errResp("YF unavailable: " + _t.utils.statusInfo(cm)));
            } else { cb.call(_t, _t._errResp("curl error: " + (err || "unknown"))); }
        }, { argv: args });
    },
    _errResp(msg) {
        return JSON.stringify({ quoteResponse: { result: [], error: msg ? msg.trim() : ABSENT } });
    }
};

// ---------------------------------------------------------------------------
// Currency code → symbol map
// ---------------------------------------------------------------------------
const CURRENCY_SYMBOLS = {
    AED:"\u062F.\u0625",AFN:"\u060B",ALL:"Lek",AMD:"\u058F",ANG:"\u0192",AOA:"Kz",ARS:"$",AUD:"$",AWG:"\u0192",AZN:"\u20BC",
    BAM:"KM",BBD:"$",BDT:"\u09F3",BGN:"\u043B\u0432",BHD:"\u062F.\u0628",BIF:"FBu",BMD:"$",BND:"$",BOB:"Bs",BRL:"R$",BSD:"$",BTN:"Nu.",BWP:"P",BYN:"Br",BZD:"BZ$",
    CAD:"$",CDF:"FC",CHF:"CHF",CLP:"$",CNY:"\u00A5",COP:"$",CRC:"\u20A1",CUP:"\u20B1",CVE:"Esc",CZK:"K\u010D",
    DJF:"Fdj",DKK:"kr",DOP:"RD$",DZD:"\u062F.\u062C",
    EGP:"\u00A3",ERN:"Nfk",EUR:"\u20AC",
    FJD:"$",FKP:"\u00A3",
    GBP:"\u00A3",GEL:"\u20BE",GHS:"\u00A2",GIP:"\u00A3",GMD:"D",GNF:"FG",GTQ:"Q",GYD:"$",
    HKD:"$",HNL:"L",HTG:"G",HUF:"Ft",
    IDR:"Rp",ILS:"\u20AA",INR:"\u20B9",IQD:"\u0639.\u062F",IRR:"\uFDFC",ISK:"kr",
    JMD:"J$",JOD:"\u062F.\u0623",JPY:"\u00A5",
    KES:"KSh",KGS:"\u20C0",KHR:"\u17DB",KMF:"CF",KPW:"\u20A9",KRW:"\u20A9",KWD:"\u062F.\u0643",KYD:"$",KZT:"\u20B8",
    LAK:"\u20AD",LBP:"\u00A3",LKR:"\u20A8",LRD:"$",LSL:"L",LYD:"\u0644.\u062F",
    MAD:".\u062F.\u0645",MDL:"L",MGA:"Ar",MKD:"\u0434\u0435\u043D",MMK:"K",MNT:"\u20AE",MOP:"P",MRU:"UM",MUR:"\u20A8",MVR:"Rf",MWK:"K",MXN:"$",MYR:"RM",MZN:"MT",
    NAD:"$",NGN:"\u20A6",NIO:"C$",NOK:"kr",NPR:"\u20A8",NZD:"$",
    OMR:"\uFDFC",
    PAB:"B/.",PEN:"S/",PGK:"K",PHP:"\u20B1",PKR:"\u20A8",PLN:"z\u0142",PYG:"Gs",
    QAR:"\uFDFC",
    RON:"lei",RSD:"\u0414\u0438\u043D",RUB:"\u20BD",RWF:"FRw",
    SAR:"\uFDFC",SBD:"$",SCR:"\u20A8",SDG:"\u062C.\u0633",SEK:"kr",SGD:"$",SHP:"\u00A3",SLE:"Le",SOS:"S",SRD:"$",SSP:"SSP",SVC:"$",SYP:"\u00A3",SZL:"L",
    THB:"\u0E3F",TJS:"SM",TMT:"T",TND:"\u062F.\u062A",TOP:"T$",TRY:"\u20BA",TTD:"TT$",TVD:"$",TWD:"NT$",TZS:"T",
    UAH:"\u20B4",UGX:"USh",USD:"$",UYU:"$U",UZS:"\u043B\u0432",
    VEF:"Bs",VND:"\u20AB",VUV:"Vt",
    WST:"T",
    XAF:"F",XCD:"$",XOF:"F",XPF:"F",
    YER:"\uFDFC",
    ZAR:"R",ZMW:"K",ZWG:"ZK"
};

const TREND_UP    = "\u25B2"; // ▲
const TREND_DOWN  = "\u25BC"; // ▼
const TREND_FLAT  = "\u25CF"; // ●

// ---------------------------------------------------------------------------
// YFTickerDesklet — main desklet class
// ---------------------------------------------------------------------------
function YFTickerDesklet(metadata, deskletId) { this.init(metadata, deskletId); }

YFTickerDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    init(metadata, deskletId) {
        Desklet.Desklet.prototype._init.call(this, metadata, deskletId);

        this.utils       = new YFUtils(deskletId);
        this.reader      = new YFReader(deskletId);
        this.metadata    = metadata;
        this.id          = deskletId;

        // data update timer
        this.updateId    = 0;
        this.allowNewTimer = false;
        this.authAttempts  = 0;

        // scroll animation
        this.scrollId    = 0;
        this.tickerX     = 0;
        this.halfWidth   = 0;

        // main actor references
        this.mainBox     = null;
        this.tickerBox   = null;

        this.lastData = {
            symbolsArg: "",
            result: [],
            error: null,
            updatedAt: new Date()
        };

        this.loadSettings();
        if (this.cacheAuthorizationParameters) {
            this.reader.restoreCache(this.authorizationParameters);
        }
        // Render immediately (shows "Loading…") so the desklet is never blank white
        this.render();
        this.onQuotesListChanged();
    },

    // -------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------
    loadSettings() {
        this.settings = new Settings.DeskletSettings(this, this.metadata.uuid, this.id);

        // appearance — trigger full re-render on size change
        const displayKeys = ["tickerWidth", "tickerHeight", "backgroundColor", "transparency",
            "cornerRadius", "borderWidth", "borderColor"];
        displayKeys.forEach(k => this.settings.bind(k, k, this.onDisplayChanged));

        // render options — just re-render ticker content
        const renderKeys = ["showChangeIcon", "showMarketPrice", "showCurrencyCode",
            "showAbsoluteChange", "showPercentChange",
            "fontColor", "scaleFontSize", "fontScale",
            "uptrendChangeColor", "downtrendChangeColor", "unchangedTrendColor", "scrollSpeed"];
        renderKeys.forEach(k => this.settings.bind(k, k, this.onRenderChanged));

        // data fetch
        this.settings.bind("delayMinutes", "delayMinutes", this.onDataFetchChanged);

        // manual refresh — no auto callback
        const manualKeys = ["quoteSymbols", "cacheAuthorizationParameters", "authorizationParameters",
            "sendCustomUserAgent", "customUserAgent", "enableCurl", "curlCommand"];
        manualKeys.forEach(k => this.settings.bind(k, k));
    },

    getNetworkSettings() {
        let curlOk = false;
        if (this.enableCurl && this.curlCommand && Gio.file_new_for_path(this.curlCommand).query_exists(null)) {
            curlOk = true;
        } else if (this.enableCurl) {
            this.utils.warn("curl path invalid, falling back to libsoup");
        }
        return {
            customUserAgent: this.sendCustomUserAgent ? this.customUserAgent : null,
            enableCurl: curlOk,
            curlCommand: curlOk ? this.curlCommand : null,
            cacheAuthorizationParameters: this.cacheAuthorizationParameters
        };
    },

    getDisplaySettings() {
        const fontSize = this.scaleFontSize
            ? Math.round(BASE_FONT_SIZE * this.fontScale * global.ui_scale)
            : -1;
        return {
            showChangeIcon:   this.showChangeIcon,
            showPrice:        this.showMarketPrice,
            showCurrency:     this.showCurrencyCode,
            showAbsChange:    this.showAbsoluteChange,
            showPctChange:    this.showPercentChange,
            fontColor:        this.fontColor,
            fontSize:         fontSize,
            uptrendColor:     this.uptrendChangeColor,
            downtrendColor:   this.downtrendChangeColor,
            unchangedColor:   this.unchangedTrendColor
        };
    },

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------
    onDisplayChanged() {
        this.utils.debug("onDisplayChanged");
        this.render();
    },

    onRenderChanged() {
        this.utils.debug("onRenderChanged");
        this.render();
    },

    onDataFetchChanged() {
        this.utils.debug("onDataFetchChanged");
        this.replaceUpdateTimer();
    },

    onManualRefreshRequested() {
        this.utils.debug("onManualRefreshRequested");
        this.onQuotesListChanged();
    },

    onNetworkSettingsChanged() {
        this.utils.debug("onNetworkSettingsChanged");
        this.authAttempts = 0;
        this.reader.dropAuth();
        this.saveAuthParams(true);
        this.replaceUpdateTimer(true);
    },

    // -------------------------------------------------------------------------
    // Data fetch pipeline  (identical flow to yfquotes@thegli)
    // -------------------------------------------------------------------------
    onQuotesListChanged() {
        if (this.allowNewTimer) return;
        this.removeUpdateTimer();
        const symArg = this.utils.buildSymbolsArg(this.quoteSymbols);
        const net    = this.getNetworkSettings();
        try {
            if (this.reader.hasCrumb()) {
                this._fetchFinance(symArg, net);
            } else if (this.authAttempts < MAX_AUTH_ATTEMPTS) {
                this._fetchCookie(symArg, net);
            } else {
                this.reader.dropAuth();
                this.saveAuthParams(true);
            }
        } catch(e) {
            this.utils.ex("onQuotesListChanged", e);
            this._failedFetch(e, symArg);
        }
    },

    _fetchFinance(symArg, net) {
        const _t = this;
        this.reader.retrieveFinanceData(symArg, net, (resp, instant=false, dropCache=false) => {
            if (dropCache) _t.saveAuthParams(true);
            try {
                const parsed = JSON.parse(resp);
                _t.lastData = {
                    symbolsArg: symArg,
                    result:    parsed.quoteResponse.result,
                    error:     parsed.quoteResponse.error,
                    updatedAt: new Date()
                };
                _t.replaceUpdateTimer(instant);
                _t.render();
            } catch(e) {
                _t.utils.ex("_fetchFinance JSON parse", e);
                _t._failedFetch(e, symArg);
            }
        });
    },

    _fetchCookie(symArg, net) {
        const _t = this;
        this.reader.retrieveCookie(net.customUserAgent, (msg, body) => {
            if (_t.reader.hasCookieInJar(AUTH_COOKIE)) {
                // Store cookie value so curl requests can include it
                _t.reader.setCookieFromJar(AUTH_COOKIE);
                _t._fetchCrumb(symArg, net);
            } else if (_t.reader.hasCookieInJar(CONSENT_COOKIE)) {
                _t._processConsent(msg, body, symArg, net);
            } else {
                _t.authAttempts++;
                _t._failedFetch("Failed to retrieve auth cookie");
            }
        });
    },

    _processConsent(authMsg, page, symArg, net) {
        const _t = this;
        const FORM_PAT   = /(<form method="post")(.*)(action="">)/;
        const FIELDS_PAT = /(<input type="hidden" name=")(.*?)(" value=")(.*?)(">)/g;
        let fields = "";
        if (FORM_PAT.test(page)) {
            let m, n = 0;
            while (n < 20 && (m = FIELDS_PAT.exec(page)) != null) { fields += m[2] + "=" + m[4] + "&"; n++; }
            fields += "reject=reject";
            this.reader.postConsent(net.customUserAgent, fields, (consentMsg) => {
                if (_t.reader.hasCookieInJar(AUTH_COOKIE)) {
                    _t.reader.setCookieFromJar(AUTH_COOKIE);
                    _t._fetchCrumb(symArg, net);
                } else { _t.authAttempts++; _t._failedFetch("Consent failed"); }
            });
        } else {
            this.authAttempts++;
            this._failedFetch("Consent form not found");
        }
    },

    _fetchCrumb(symArg, net) {
        if (this.authAttempts >= MAX_AUTH_ATTEMPTS) return;
        const _t = this;
        this.reader.retrieveCrumb(net, (msg, body) => {
            let crumb = null;
            if (body) {
                if (typeof body.data === "string" && body.data.trim() !== "" && !/\s/.test(body.data)) crumb = body.data;
                else if (typeof body === "string" && body.trim() !== "" && !/\s/.test(body)) crumb = body;
            }
            if (crumb) {
                _t.reader.setCrumb(crumb);
                if (net.cacheAuthorizationParameters) _t.saveAuthParams();
                _t._fetchFinance(symArg, net);
            } else {
                _t.authAttempts++;
                _t.saveAuthParams(true);
                _t._failedFetch("Failed to retrieve crumb");
            }
        });
    },

    saveAuthParams(drop = false) {
        const json = drop ? DEFAULT_CACHED_AUTH_PARAMS : this.reader.prepareCache();
        this.settings.setValue("authorizationParameters", json);
    },

    _failedFetch(msg, symArg = "") {
        const errResp = JSON.parse(this.reader._errResp(String(msg)));
        this.lastData = {
            symbolsArg: symArg,
            result: errResp.quoteResponse.result,
            error:  errResp.quoteResponse.error,
            updatedAt: new Date()
        };
        this.replaceUpdateTimer();
        this.render();
    },

    // -------------------------------------------------------------------------
    // Update timer
    // -------------------------------------------------------------------------
    replaceUpdateTimer(instant = false) {
        this.removeUpdateTimer();
        if (!this.allowNewTimer) return;
        const delay = instant ? 1 : this.delayMinutes * 60;
        this.updateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this.onQuotesListChanged();
            return GLib.SOURCE_CONTINUE;
        });
        this.allowNewTimer = false;
    },

    removeUpdateTimer(shutdown = false) {
        if (this.updateId > 0) { GLib.source_remove(this.updateId); this.updateId = 0; }
        this.allowNewTimer = !shutdown;
    },

    // -------------------------------------------------------------------------
    // Scroll animation
    // -------------------------------------------------------------------------
    _startScroll() {
        this._stopScroll();
        const pixelsPerMs = Math.max(1, this.scrollSpeed) / SCROLL_INTERVAL_MS;
        const _t = this;
        let lastUs = GLib.get_monotonic_time();
        this.scrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_INTERVAL_MS, () => {
            if (!_t.tickerBox) return GLib.SOURCE_REMOVE;
            const nowUs = GLib.get_monotonic_time();
            const elapsedMs = (nowUs - lastUs) / 1000;
            lastUs = nowUs;
            // Cap elapsed time to avoid a large jump after a suspend/freeze
            _t.tickerX -= pixelsPerMs * Math.min(elapsedMs, SCROLL_INTERVAL_MS * 4);
            if (_t.halfWidth > 0 && _t.tickerX <= -_t.halfWidth) {
                _t.tickerX += _t.halfWidth;
            }
            _t.tickerBox.set_x(Math.round(_t.tickerX));
            return GLib.SOURCE_CONTINUE;
        });
    },

    _stopScroll() {
        if (this.scrollId > 0) { GLib.source_remove(this.scrollId); this.scrollId = 0; }
    },

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------
    render() {
        this.utils.debug("render");

        // If quote list changed since last fetch, trigger new fetch
        if (this.authAttempts < MAX_AUTH_ATTEMPTS &&
            !this.utils.compareSymbolsArg(this.lastData.symbolsArg, this.quoteSymbols)) {
            this.onQuotesListChanged();
            return;
        }

        // Stop current animation before building new content
        this._stopScroll();

        const ds = this.getDisplaySettings();
        const fontStyle = ds.fontSize > 0 ? `font-size:${ds.fontSize}px;` : "";
        const bgColor   = this._buildBgColor(this.backgroundColor, this.transparency);
        const radius    = Math.max(this.cornerRadius, this.borderWidth);
        let mainStyle   = `background-color:${bgColor}; border-radius:${radius}px;`;
        if (this.borderWidth > 0) {
            mainStyle += ` border:${this.borderWidth}px solid ${this.borderColor};`;
        }

        // Build new outer container (fixed size, clips children)
        const newMain = new St.Widget({
            style_class: "yfticker-main",
            style: mainStyle,
            width: this.tickerWidth,
            height: this.tickerHeight
        });
        newMain.set_clip_to_allocation(true);

        // Compute vertical padding so items are centered in the ticker bar
        const estimatedFontH = ds.fontSize > 0 ? ds.fontSize : BASE_FONT_SIZE;
        const vPad = Math.max(2, Math.round((this.tickerHeight - estimatedFontH * 1.6) / 2));

        // Build new inner ticker row
        const newTicker = new St.BoxLayout({ vertical: false });

        const quotes  = this.lastData.result;
        const hasData = quotes && quotes.length > 0;

        if (!hasData) {
            const text = this.lastData.error
                ? _("Error: %s").format(String(this.lastData.error))
                : _("Loading…");
            const label = new St.Label({
                text: text,
                style_class: this.lastData.error ? "yfticker-error" : "yfticker-loading",
                style: `color:${ds.fontColor}; ${fontStyle} padding-top:${vPad}px; padding-bottom:${vPad}px;`
            });
            newTicker.add_actor(label);
        } else {
            // Build two copies for seamless looping
            this._addQuoteItems(newTicker, quotes, ds, fontStyle, vPad);
            this._addSpacer(newTicker);
            this._addQuoteItems(newTicker, quotes, ds, fontStyle, vPad);
            this._addSpacer(newTicker);
        }

        newTicker.set_x(0);
        newMain.add_actor(newTicker);

        // Atomically replace content — no blank frame between old and new
        this.setContent(newMain);

        // Now it's safe to destroy the old actors
        if (this.mainBox) {
            this.mainBox.destroy_all_children();
            this.mainBox.destroy();
        }
        this.mainBox  = newMain;
        this.tickerBox = newTicker;
        this.tickerX  = 0;
        this.halfWidth = 0;

        if (hasData) {
            // Measure after a short delay so Clutter has allocated the actor
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                if (this.tickerBox !== newTicker) return GLib.SOURCE_REMOVE;
                const [, natW] = this.tickerBox.get_preferred_width(-1);
                this.halfWidth = natW / 2;
                this._startScroll();
                return GLib.SOURCE_REMOVE;
            });
        }
    },

    _addQuoteItems(box, quotes, ds, fontStyle, vPad) {
        for (let i = 0; i < quotes.length; i++) {
            if (i > 0) this._addSeparator(box, ds, fontStyle, vPad);
            this._addQuoteItem(box, quotes[i], ds, fontStyle, vPad);
        }
    },

    _addQuoteItem(box, quote, ds, fontStyle, vPad) {
        const pct = this.utils.has(quote, "regularMarketChangePercent")
            ? parseFloat(quote.regularMarketChangePercent) : 0;

        let trendColor;
        let trendIcon;
        if (pct > 0)      { trendColor = ds.uptrendColor;   trendIcon = TREND_UP;   }
        else if (pct < 0) { trendColor = ds.downtrendColor; trendIcon = TREND_DOWN; }
        else              { trendColor = ds.unchangedColor;  trendIcon = TREND_FLAT; }

        const pad = `padding-top:${vPad}px; padding-bottom:${vPad}px;`;

        // Item wrapper — subtle background tint
        const item = new St.BoxLayout({
            vertical: false,
            style_class: "yfticker-item",
            style: `background-color: rgba(255,255,255,0.04); border-radius:6px; ${pad}`
        });

        // Trend icon
        if (ds.showChangeIcon) {
            const icon = new St.Label({
                text: trendIcon,
                style_class: "yfticker-icon",
                style: `color:${trendColor}; ${fontStyle}`
            });
            item.add_actor(icon);
        }

        // Symbol
        const sym = new St.Label({
            text: quote.symbol,
            style_class: "yfticker-symbol",
            style: `color:${ds.fontColor}; ${fontStyle} font-weight:bold;`
        });
        item.add_actor(sym);

        // Price
        if (ds.showPrice && this.utils.has(quote, "regularMarketPrice")) {
            let priceText = "";
            if (ds.showCurrency && this.utils.has(quote, "currency")) {
                priceText = (CURRENCY_SYMBOLS[quote.currency] || quote.currency);
            }
            priceText += this.utils.roundAmt(quote.regularMarketPrice, 2, false);
            const price = new St.Label({
                text: priceText,
                style_class: "yfticker-price",
                style: `color:${ds.fontColor}; ${fontStyle}`
            });
            item.add_actor(price);
        }

        // Absolute change
        if (ds.showAbsChange && this.utils.has(quote, "regularMarketChange")) {
            const abs = quote.regularMarketChange;
            const sign = abs >= 0 ? "+" : "";
            const label = new St.Label({
                text: sign + this.utils.roundAmt(abs, 2, false),
                style_class: "yfticker-change",
                style: `color:${trendColor}; ${fontStyle}`
            });
            item.add_actor(label);
        }

        // Percent change
        if (ds.showPctChange && this.utils.has(quote, "regularMarketChangePercent")) {
            const sign = pct >= 0 ? "+" : "";
            const label = new St.Label({
                text: sign + this.utils.roundAmt(pct, 2, false) + "%",
                style_class: "yfticker-change",
                style: `color:${trendColor}; ${fontStyle} font-weight:bold;`
            });
            item.add_actor(label);
        }

        box.add_actor(item);
    },

    _addSeparator(box, ds, fontStyle, vPad) {
        const pad = `padding-top:${vPad}px; padding-bottom:${vPad}px;`;
        const sep = new St.Label({
            text: "·",
            style_class: "yfticker-separator",
            style: `color:${ds.fontColor}; ${fontStyle} ${pad}`
        });
        box.add_actor(sep);
    },

    _addSpacer(box) {
        // Wider gap between the two copies so the loop reset isn't jarring
        const spacer = new St.Label({
            text: "          ",
            style_class: "yfticker-separator"
        });
        box.add_actor(spacer);
    },

    // -------------------------------------------------------------------------
    // Style helpers
    // -------------------------------------------------------------------------
    _buildBgColor(rgb, alpha) {
        const m = rgb && rgb.match(/\((.*?)\)/);
        if (m) {
            const c = m[1].split(",").map(s => parseInt(s, 10));
            if (c.length === 3 && !c.some(isNaN)) return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
        }
        return `rgba(10,10,18,${alpha})`;
    },

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    on_desklet_removed() {
        this.utils.debug("on_desklet_removed");
        this.removeUpdateTimer(true);
        this.unrender();
    },

    unrender() {
        this._stopScroll();
        this.tickerBox = null;
        this.halfWidth = 0;
        this.tickerX   = 0;
        if (this.mainBox) {
            this.mainBox.destroy_all_children();
            this.mainBox.destroy();
            this.mainBox = null;
        }
    }
};

// ---------------------------------------------------------------------------
function main(metadata, deskletId) {
    return new YFTickerDesklet(metadata, deskletId);
}
