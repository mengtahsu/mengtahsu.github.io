class MyAmbiCloud {
  constructor(config) {
    this.url = String(config?.supabaseUrl || "").replace(/\/$/, "");
    this.key = String(config?.publishableKey || "");
    this.storageKey = "myambi.supabase.session";
    this.deviceKey = "myambi.trusted.device";
    this.loggedOutKey = "myambi.logged.out";
    this.pendingLoginKey = "myambi.pending.login";
    this.householdKey = "myambi.active.household";
    this.activeHouseholdId = localStorage.getItem(this.householdKey) || null;
    this.callbackError = this.readCallbackError();
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

  readCallbackError() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(location.search);
    const message = hash.get("error_description") || query.get("error_description") ||
      hash.get("error") || query.get("error");
    if (!message) return null;
    history.replaceState({}, document.title, location.pathname);
    return decodeURIComponent(String(message).replace(/\+/g, " "));
  }

  readSession() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || "null"); }
    catch (_) { localStorage.removeItem(this.storageKey); return null; }
  }

  saveSession(session) {
    const expiresAt = session?.expires_at || Math.floor(Date.now() / 1000) + Number(session?.expires_in || 3600);
    this.session = { ...session, expires_at: expiresAt };
    localStorage.setItem(this.storageKey, JSON.stringify(this.session));
  }

  clearSession() {
    this.session = null;
    localStorage.removeItem(this.storageKey);
  }

  pendingLogin() {
    try {
      const pending = JSON.parse(localStorage.getItem(this.pendingLoginKey) || "null");
      if (!pending?.email || Date.now() - Number(pending.sent_at || 0) > 60 * 60 * 1000) {
        localStorage.removeItem(this.pendingLoginKey);
        return null;
      }
      return pending;
    } catch (_) {
      localStorage.removeItem(this.pendingLoginKey);
      return null;
    }
  }

  baseHeaders(authenticated = true) {
    const headers = { apikey: this.key, Accept: "application/json" };
    if (authenticated && this.session?.access_token) headers.Authorization = `Bearer ${this.session.access_token}`;
    if (authenticated && this.activeHouseholdId) headers["x-myambi-household-id"] = this.activeHouseholdId;
    return headers;
  }

  setActiveHousehold(householdId) {
    this.activeHouseholdId = householdId || null;
    if (this.activeHouseholdId) localStorage.setItem(this.householdKey, this.activeHouseholdId);
    else localStorage.removeItem(this.householdKey);
  }

  async request(url, options = {}, authenticated = true) {
    if (!this.configured) throw new Error("請先在 web/config.js 設定 Supabase 專案");
    if (authenticated) await this.ensureSession();
    const headers = { ...this.baseHeaders(authenticated), ...(options.headers || {}) };
    if (options.body !== undefined && options.body !== null && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      ...options,
      headers,
    });
    const raw = await response.text();
    let data = {};
    if (raw.trim()) {
      try { data = JSON.parse(raw); }
      catch (_) {
        throw new Error(response.ok ? "伺服器回應格式不完整，請再試一次" : `HTTP ${response.status}`);
      }
    }
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

  async sendMagicLink(email) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const redirect = `${location.origin}${location.pathname}?handoff=1`;
    const result = await this.request(
      `${this.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`,
      { method: "POST", body: JSON.stringify({ email: normalizedEmail, create_user: true }) },
      false,
    );
    localStorage.setItem(this.pendingLoginKey, JSON.stringify({ email: normalizedEmail, sent_at: Date.now() }));
    return result;
  }

  async createHandoff() {
    return this.request(`${this.url}/functions/v1/auth-handoff`, {
      method: "POST",
      body: JSON.stringify({ action: "create" }),
    });
  }

  async claimHandoff(code) {
    const result = await this.request(
      `${this.url}/functions/v1/auth-handoff`,
      { method: "POST", body: JSON.stringify({ action: "claim", code }) },
      false,
    );
    if (!result.session?.access_token || !result.session?.refresh_token) {
      throw new Error("配對完成，但沒有取得登入狀態");
    }
    this.saveSession(result.session);
    if (result.device_token) localStorage.setItem(this.deviceKey, result.device_token);
    localStorage.removeItem(this.loggedOutKey);
    localStorage.removeItem(this.pendingLoginKey);
    return result.session;
  }

  hasTrustedDevice() {
    return Boolean(localStorage.getItem(this.deviceKey));
  }

  async restoreDevice() {
    const deviceToken = localStorage.getItem(this.deviceKey);
    if (!deviceToken) throw new Error("這台裝置尚未配對");
    const result = await this.request(
      `${this.url}/functions/v1/auth-handoff`,
      { method: "POST", body: JSON.stringify({ action: "restore", device_token: deviceToken }) },
      false,
    );
    if (!result.session?.access_token || !result.session?.refresh_token) {
      throw new Error("無法恢復登入狀態");
    }
    this.saveSession(result.session);
    localStorage.removeItem(this.loggedOutKey);
    return result.session;
  }

  async user() {
    if (!this.session && this.hasTrustedDevice() && !localStorage.getItem(this.loggedOutKey)) {
      try { await this.restoreDevice(); }
      catch (_) { localStorage.removeItem(this.deviceKey); }
    }
    if (!this.session) return null;
    try { return await this.request(`${this.url}/auth/v1/user`); }
    catch (error) {
      this.clearSession();
      if (error.message === "請先登入" || /401|JWT|token/i.test(error.message)) {
        if (this.hasTrustedDevice() && !localStorage.getItem(this.loggedOutKey)) {
          try {
            await this.restoreDevice();
            return await this.request(`${this.url}/auth/v1/user`);
          } catch (_) { localStorage.removeItem(this.deviceKey); }
        }
        return null;
      }
      throw error;
    }
  }

  async signOut() {
    if (this.session) {
      await fetch(`${this.url}/auth/v1/logout`, { method: "POST", headers: this.baseHeaders() }).catch(() => {});
    }
    this.clearSession();
    if (this.hasTrustedDevice()) localStorage.setItem(this.loggedOutKey, "1");
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
