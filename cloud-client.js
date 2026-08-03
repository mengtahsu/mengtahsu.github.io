class MyAmbiCloud {
  constructor(config) {
    this.url = String(config?.supabaseUrl || "").replace(/\/$/, "");
    this.key = String(config?.publishableKey || "");
    this.storageKey = "myambi.supabase.session";
    this.session = this.readSessionFromURL() || this.readSession();
  }

  get configured() {
    return this.url.startsWith("https://") && !this.url.includes("YOUR_PROJECT") && this.key.length > 20;
  }

  readSessionFromURL() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (!params.get("access_token")) return null;
    const session = {
      access_token: params.get("access_token"),
      refresh_token: params.get("refresh_token"),
      expires_at: Math.floor(Date.now() / 1000) + Number(params.get("expires_in") || 3600),
    };
    localStorage.setItem(this.storageKey, JSON.stringify(session));
    history.replaceState({}, document.title, location.pathname + location.search);
    return session;
  }

  readSession() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || "null"); }
    catch (_) { return null; }
  }

  saveSession(session) {
    this.session = session;
    localStorage.setItem(this.storageKey, JSON.stringify(session));
  }

  clearSession() {
    this.session = null;
    localStorage.removeItem(this.storageKey);
  }

  baseHeaders(authenticated = true) {
    const headers = { apikey: this.key, "Content-Type": "application/json" };
    if (authenticated && this.session?.access_token) headers.Authorization = `Bearer ${this.session.access_token}`;
    return headers;
  }

  async request(url, options = {}, authenticated = true) {
    if (!this.configured) throw new Error("請先在 web/config.js 設定 Supabase 專案");
    if (authenticated) await this.ensureSession();
    const response = await fetch(url, {
      ...options,
      headers: { ...this.baseHeaders(authenticated), ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || data.msg || data.error || `HTTP ${response.status}`);
    return data;
  }

  async ensureSession() {
    if (!this.session?.access_token) throw new Error("請先登入");
    if ((this.session.expires_at || 0) > Math.floor(Date.now() / 1000) + 60) return;
    if (!this.session.refresh_token) { this.clearSession(); throw new Error("登入已過期"); }
    const refreshed = await this.request(
      `${this.url}/auth/v1/token?grant_type=refresh_token`,
      { method: "POST", body: JSON.stringify({ refresh_token: this.session.refresh_token }) },
      false,
    );
    this.saveSession({ ...refreshed, expires_at: Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600) });
  }

  async sendMagicLink(email, displayName = "") {
    const redirect = `${location.origin}${location.pathname}`;
    return this.request(
      `${this.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`,
      { method: "POST", body: JSON.stringify({ email, create_user: true, data: { display_name: displayName } }) },
      false,
    );
  }

  async user() {
    if (!this.session) return null;
    try { return await this.request(`${this.url}/auth/v1/user`); }
    catch (_) { this.clearSession(); return null; }
  }

  async signOut() {
    if (this.session) {
      await fetch(`${this.url}/auth/v1/logout`, { method: "POST", headers: this.baseHeaders() }).catch(() => {});
    }
    this.clearSession();
  }

  function(action, body = {}, method = "POST") {
    return this.request(`${this.url}/functions/v1/myambi-api/${action}`, {
      method, body: method === "GET" ? undefined : JSON.stringify(body),
    });
  }

  async rest(table, query = "") {
    return this.request(`${this.url}/rest/v1/${table}${query ? `?${query}` : ""}`, {
      headers: { Prefer: "count=none" },
    });
  }
}

window.MyAmbiCloud = MyAmbiCloud;

