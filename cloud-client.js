class MyAmbiCloud {
  constructor(config) {
    this.url = String(config?.supabaseUrl || "").replace(/\/$/, "");
    this.key = String(config?.publishableKey || "");
    this.storageKey = "myambi.supabase.session";
    this.deviceKey = "myambi.trusted.device";
    this.deviceUserKey = "myambi.trusted.user";
    this.loggedOutKey = "myambi.logged.out";
    this.passwordResetKey = "myambi.password.reset.active";
    this.householdKey = "myambi.active.household";
    this.callbackType = null;
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
    this.callbackType = params.get("type") || null;
    const callbackQuery = new URLSearchParams(location.search);
    const isPasswordCallback = ["recovery", "invite"].includes(this.callbackType) ||
      callbackQuery.get("password-reset") === "1" ||
      callbackQuery.get("set-password") === "1";
    const isJoinCallback = Boolean(callbackQuery.get("join"));
    if (isPasswordCallback) {
      localStorage.setItem(this.passwordResetKey, "1");
    }
    if (isPasswordCallback || isJoinCallback) {
      // The link may be opened on a phone that previously remembered a
      // different account. Never let that old device token take over later.
      localStorage.removeItem(this.deviceKey);
      localStorage.removeItem(this.deviceUserKey);
      localStorage.removeItem(this.loggedOutKey);
    }
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
    ["error", "error_code", "error_description"].forEach((key) => query.delete(key));
    history.replaceState({}, document.title, `${location.pathname}${query.size ? `?${query}` : ""}`);
    // URLSearchParams already decodes the value. Decoding it again can throw
    // on malformed input and leave the app on a blank screen.
    return String(message).replace(/\+/g, " ");
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

  clearCallbackError() {
    this.callbackError = null;
  }

  sessionUserId() {
    try {
      const payload = this.session?.access_token?.split(".")?.[1];
      if (!payload) return null;
      const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const decoded = JSON.parse(atob(padded));
      return typeof decoded.sub === "string" ? decoded.sub : null;
    } catch (_) {
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
    const controller = options.signal ? null : new AbortController();
    const timeout = controller ? setTimeout(() => controller.abort(), 30000) : null;
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("連線逾時，請確認網路後重試");
      if (error instanceof TypeError) throw new Error("目前無法連線，請確認網路後重試");
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const raw = await response.text();
    let data = {};
    if (raw.trim()) {
      try { data = JSON.parse(raw); }
      catch (_) {
        throw new Error(response.ok ? "伺服器回應格式不完整，請再試一次" : `HTTP ${response.status}`);
      }
    }
    if (!response.ok) {
      const requestError = new Error(data.error_description || data.msg || data.error || `HTTP ${response.status}`);
      requestError.status = response.status;
      throw requestError;
    }
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

  async signInWithPassword(email, password) {
    const result = await this.request(
      `${this.url}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        body: JSON.stringify({
          email: String(email || "").trim().toLowerCase(),
          password: String(password || ""),
        }),
      },
      false,
    );
    // A deliberate password login chooses this account for the device. An old
    // remembered token may belong to a different family member.
    localStorage.removeItem(this.deviceKey);
    localStorage.removeItem(this.deviceUserKey);
    this.saveSession(result);
    localStorage.removeItem(this.loggedOutKey);
    this.clearPasswordReset();
    this.clearCallbackError();
    let deviceRemembered = true;
    try {
      await this.registerTrustedDevice();
    } catch (_) {
      deviceRemembered = false;
    }
    return { ...result, device_remembered: deviceRemembered };
  }

  async signUpWithPassword(email, password, displayName, joinToken) {
    const redirect = new URL(location.pathname, location.origin);
    if (joinToken) redirect.searchParams.set("join", joinToken);
    const result = await this.request(
      `${this.url}/auth/v1/signup?redirect_to=${encodeURIComponent(redirect.toString())}`,
      {
        method: "POST",
        body: JSON.stringify({
          email: String(email || "").trim().toLowerCase(),
          password: String(password || ""),
          data: { display_name: String(displayName || "").trim() },
        }),
      },
      false,
    );
    if (result.access_token && result.refresh_token) {
      localStorage.removeItem(this.deviceKey);
      localStorage.removeItem(this.deviceUserKey);
      this.saveSession(result);
      localStorage.removeItem(this.loggedOutKey);
      try { await this.registerTrustedDevice(); } catch (_) {}
    }
    return result;
  }

  joinToken() {
    return new URLSearchParams(location.search).get("join") || "";
  }

  invitePreview(token) {
    const query = new URLSearchParams({ action: "preview", token });
    return this.request(`${this.url}/functions/v1/household-invite?${query}`, { method: "GET" }, false);
  }

  householdInvite(action, payload = {}) {
    return this.request(`${this.url}/functions/v1/household-invite`, {
      method: "POST",
      body: JSON.stringify({ action, ...payload }),
    });
  }

  passwordResetActive() {
    return ["recovery", "invite"].includes(this.callbackType) ||
      localStorage.getItem(this.passwordResetKey) === "1";
  }

  clearPasswordReset() {
    this.callbackType = null;
    localStorage.removeItem(this.passwordResetKey);
  }

  async sendPasswordReset(email) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const redirect = `${location.origin}${location.pathname}?password-reset=1`;
    await this.request(
      `${this.url}/auth/v1/recover?redirect_to=${encodeURIComponent(redirect)}`,
      { method: "POST", body: JSON.stringify({ email: normalizedEmail }) },
      false,
    );
  }

  async updatePassword(password) {
    return this.request(`${this.url}/auth/v1/user`, {
      method: "PUT",
      body: JSON.stringify({ password: String(password || "") }),
    });
  }

  async registerTrustedDevice() {
    const currentUserId = this.sessionUserId();
    const rememberedUserId = localStorage.getItem(this.deviceUserKey);
    if (this.hasTrustedDevice() && currentUserId && rememberedUserId === currentUserId) return;
    localStorage.removeItem(this.deviceKey);
    localStorage.removeItem(this.deviceUserKey);
    const result = await this.request(`${this.url}/functions/v1/auth-handoff`, {
      method: "POST",
      body: JSON.stringify({ action: "register" }),
    });
    if (!result.device_token) throw new Error("無法記住這台裝置");
    localStorage.setItem(this.deviceKey, result.device_token);
    const registeredUserId = result.user_id || currentUserId;
    if (registeredUserId) localStorage.setItem(this.deviceUserKey, registeredUserId);
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
    if (result.user_id) localStorage.setItem(this.deviceUserKey, result.user_id);
    localStorage.removeItem(this.loggedOutKey);
    this.clearCallbackError();
    return result.session;
  }

  async user() {
    if (!this.session && this.hasTrustedDevice() && !localStorage.getItem(this.loggedOutKey)) {
      try { await this.restoreDevice(); }
      catch (error) {
        if (Number(error?.status) === 401) {
          localStorage.removeItem(this.deviceKey);
          localStorage.removeItem(this.deviceUserKey);
        }
        else throw error;
      }
    }
    if (!this.session) return null;
    try { return await this.request(`${this.url}/auth/v1/user`); }
    catch (error) {
      this.clearSession();
      if (Number(error?.status) === 401 || error.message === "請先登入" || /401|JWT|token/i.test(error.message)) {
        if (this.hasTrustedDevice() && !localStorage.getItem(this.loggedOutKey)) {
          try {
            await this.restoreDevice();
            return await this.request(`${this.url}/auth/v1/user`);
          } catch (restoreError) {
            if (Number(restoreError?.status) === 401) {
              localStorage.removeItem(this.deviceKey);
              localStorage.removeItem(this.deviceUserKey);
            }
            else throw restoreError;
          }
        }
        return null;
      }
      throw error;
    }
  }

  async signOut() {
    const deviceToken = localStorage.getItem(this.deviceKey);
    if (this.session && deviceToken) {
      await this.request(`${this.url}/functions/v1/auth-handoff`, {
        method: "POST",
        body: JSON.stringify({ action: "revoke", device_token: deviceToken }),
      }).catch(() => {});
    }
    if (this.session) {
      await fetch(`${this.url}/auth/v1/logout`, { method: "POST", headers: this.baseHeaders() }).catch(() => {});
    }
    this.clearSession();
    localStorage.removeItem(this.deviceKey);
    localStorage.removeItem(this.deviceUserKey);
    localStorage.setItem(this.loggedOutKey, "1");
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
