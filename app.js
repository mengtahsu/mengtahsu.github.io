const cloud = new window.MyAmbiCloud(window.MYAMBI_CONFIG);
const state = { status: null, user: null, rooms: [], queue: [], users: [], allRooms: [], roomChoices: [], learning: [], learningContext: null, refreshTimer: null };
const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view");
const appView = $("#app-view");
const roomGrid = $("#room-grid");

function hideBoot() {
  $("#boot-view").classList.add("hidden");
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.background = isError ? "#8b3f2f" : "";
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function setBusy(element, busy) {
  if (!element) return;
  element.disabled = busy;
  element.dataset.label ||= element.textContent;
  element.textContent = busy ? "處理中…" : element.dataset.label;
}

function showAuth(mode) {
  hideBoot();
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
  $("#setup-form").classList.toggle("hidden", mode !== "setup");
  $("#login-form").classList.toggle("hidden", mode !== "login");
}

function displayName() {
  return state.user?.user_metadata?.display_name || state.user?.email?.split("@")[0] || "你";
}

function isAdmin() {
  return ["owner", "admin"].includes(state.status?.role);
}

function applyRole() {
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin()));
  document.querySelectorAll(".admin-copy").forEach((el) => el.classList.toggle("hidden", !isAdmin()));
  document.querySelectorAll(".member-copy").forEach((el) => el.classList.toggle("hidden", isAdmin()));
}

async function boot() {
  try {
    if (!cloud.configured) {
      showAuth("login");
      showToast("尚未設定 Supabase 專案；請先完成 web/config.js", true);
      return;
    }
    if (cloud.callbackError) {
      showAuth("login");
      $("#auth-error").textContent = `登入連結無法使用：${cloud.callbackError}。請重新寄一封登入信。`;
      $("#auth-error").classList.remove("hidden");
      return;
    }
    state.user = await cloud.user();
    if (!state.user) return showAuth("login");
    try {
      state.status = await cloud.function("status", {}, "GET");
    } catch (error) {
      if (error.message.includes("尚未加入")) return showAuth("setup");
      throw error;
    }
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    hideBoot();
    $("#user-name").textContent = displayName();
    applyRole();
    await loadRooms();
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(loadRooms, 15000);
  } catch (error) {
    showAuth("login");
    $("#auth-error").textContent = `登入沒有完成：${error.message}。請重新整理或重新寄登入連結。`;
    $("#auth-error").classList.remove("hidden");
    showToast(error.message, true);
  }
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "晚安";
  if (hour < 12) return "早安";
  if (hour < 18) return "午安";
  return "晚安";
}

async function loadRooms() {
  try {
    const [rooms, status, queue] = await Promise.all([
      cloud.rest("room_dashboard", "select=*&order=name.asc"),
      cloud.function("status", {}, "GET"),
      cloud.rest("ac_command_queue", "select=id,room_id,status&status=in.(pending,processing)&order=id.asc"),
    ]);
    state.rooms = rooms.filter((room) => room.is_visible !== false);
    state.status = status;
    state.queue = queue;
    renderAlerts();
    maybeNotifyAlerts();
    applyRole();
    renderRooms();
  } catch (error) { showToast(error.message, true); }
}

function displayNumber(value, digits = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function renderRooms() {
  $("#greeting").textContent = `${greeting()}，${displayName()}`;
  const onlineRooms = state.rooms.filter((room) => room.observed_at).length;
  const queueCapacity = Number(state.status?.queue_capacity ?? 5);
  const queueActive = Number(state.status?.queue_active_count ?? state.queue.length);
  const queueFree = Number(state.status?.queue_free_slots ?? Math.max(0, queueCapacity - queueActive));
  const queueHealth = state.status?.queue_healthy === true ? "" : "（檢查異常）";
  $("#summary").textContent = state.rooms.length
    ? `${onlineRooms} 個房間已有最新資料；命令佇列 ${queueActive}/${queueCapacity}，剩餘 ${queueFree} 格${queueHealth}。`
    : "加入房間後，MyAmbi 會開始記錄你的舒適感。";
  const error = state.status?.controller_error;
  const pill = $("#system-pill");
  pill.classList.toggle("error", Boolean(error));
  pill.lastChild.textContent = error ? "控制需要注意" : "雲端控制中";
  $("#error-banner").classList.toggle("hidden", !error);
  $("#error-banner").textContent = error || "";
  roomGrid.replaceChildren(...state.rooms.map(roomCard));
  $("#empty-state").classList.toggle("hidden", state.rooms.length > 0);
}

function roomCard(room) {
  const article = document.createElement("article");
  article.className = `room-card${room.override_ends_at ? " override" : ""}`;
  article.dataset.roomId = room.id;
  const isOn = Boolean(room.is_on);
  const overrideTime = room.override_ends_at
    ? new Date(room.override_ends_at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })
    : null;
  const schedule = room.schedule_enabled
    ? `${String(room.scheduled_on).slice(0, 5)} 開 · ${String(room.scheduled_off).slice(0, 5)} 關`
    : null;
  const roomQueue = state.queue.filter((command) => command.room_id === room.id);
  const firstQueuePosition = roomQueue.length
    ? state.queue.findIndex((command) => command.id === roomQueue[0].id) + 1
    : 0;
  article.innerHTML = `
    <div class="room-head"><h2></h2><span class="room-state ${isOn ? "" : "off"}">${room.observed_at ? (isOn ? "運轉中" : "已關閉") : "等待同步"}</span></div>
    <div class="temperature">${displayNumber(room.temperature, 1)}<sup>°</sup></div>
    <div class="climate-meta"><span>濕度 ${displayNumber(room.humidity)}%</span><span>${room.mode || "—"}</span></div>
    <div class="target-row">
      <button class="round temp-down" aria-label="降低一度" ${isOn ? "" : "disabled"}>−</button>
      <span>冷氣設定 <b class="target-value">${displayNumber(room.target_temperature)}°</b></span>
      <button class="round temp-up" aria-label="提高一度" ${isOn ? "" : "disabled"}>＋</button>
    </div>
    <p class="feeling-label">你現在感覺如何？</p>
    <div class="feelings">
      <button class="feeling" data-feeling="-2"><span>🥶</span>非常冷</button>
      <button class="feeling" data-feeling="-1"><span>😣</span>太冷</button>
      <button class="feeling" data-feeling="0"><span>😌</span>剛好</button>
      <button class="feeling" data-feeling="1"><span>😓</span>太熱</button>
      <button class="feeling" data-feeling="2"><span>🥵</span>非常熱</button>
    </div>
    <div class="room-actions">
      <button class="room-action workout" ${isOn ? "" : "disabled"}>運動後降溫 30 分</button>
      <button class="room-action history">查看紀錄</button>
    </div>
    ${isAdmin() ? `<button class="room-action auto-toggle">${room.automation_enabled ? "暫停自動控制" : "啟用自動控制"}</button>` : ""}
    ${schedule ? `<div class="schedule-note">${schedule}</div>` : ""}
    ${roomQueue.length ? `<div class="queue-note">佇列第 ${firstQueuePosition} 位 · 此房 ${roomQueue.length} 筆</div>` : ""}
    ${!isOn && room.observed_at ? `<div class="safe-note">安全鎖：關機中，不送溫度或風量</div>` : ""}
    ${overrideTime ? `<div class="override-note">暫時降溫至 ${overrideTime} · <button class="room-action cancel-override">提早恢復</button></div>` : ""}
  `;
  article.querySelector("h2").textContent = room.name;
  return article;
}

roomGrid.addEventListener("click", async (event) => {
  const card = event.target.closest(".room-card");
  if (!card || !(event.target instanceof HTMLButtonElement)) return;
  const roomId = card.dataset.roomId;
  const room = state.rooms.find((item) => item.id === roomId);
  try {
    setBusy(event.target, true);
    if (event.target.matches(".feeling")) {
      const result = await cloud.function("feedback", { room_id: roomId, feeling: Number(event.target.dataset.feeling) });
      showToast(result.message);
    } else if (event.target.matches(".workout")) {
      const result = await cloud.function("override", { room_id: roomId, minutes: 30, target_temperature: Math.max(23, Number(room.target_temperature || 27) - 2) });
      showToast(result.decision?.source === "off_guard"
        ? "冷氣已關機，未送出溫度指令"
        : result.decision?.dropped
        ? result.decision?.source === "queue_unhealthy"
          ? "佇列自我檢查異常，這次降溫命令已丟棄"
          : "佇列已有 5 筆，這次降溫命令已丟棄"
        : "降溫命令已排入佇列，將依序送出");
    } else if (event.target.matches(".cancel-override")) {
      const result = await cloud.function("cancel-override", { room_id: roomId });
      showToast(result.decision?.dropped
        ? result.decision?.source === "queue_unhealthy"
          ? "已取消臨時模式；佇列檢查異常，恢復溫度命令未排入"
          : "已取消臨時模式；佇列已滿，恢復溫度命令未排入"
        : "已恢復 MyAmbi 自動控制");
    } else if (event.target.matches(".temp-down, .temp-up")) {
      const delta = event.target.matches(".temp-up") ? 1 : -1;
      const target = Number(room.target_temperature || 27) + delta;
      const result = await cloud.function("temperature", { room_id: roomId, target_temperature: target });
      showToast(result.decision?.source === "off_guard"
        ? "冷氣已關機，未送出溫度指令"
        : result.decision?.dropped
        ? result.decision?.source === "queue_unhealthy"
          ? `佇列自我檢查異常，${target}° 命令已丟棄`
          : `佇列已有 5 筆，${target}° 命令已丟棄`
        : `${target}° 已排入佇列，將依序送出`);
    } else if (event.target.matches(".history")) {
      await showHistory(room);
    } else if (event.target.matches(".auto-toggle")) {
      await cloud.function("automation", { room_id: roomId, enabled: !room.automation_enabled });
      showToast(room.automation_enabled ? "已暫停自動控制" : "已啟用自動控制");
    }
    await loadRooms();
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(event.target, false); }
});

async function showHistory(room) {
  const roomFilter = encodeURIComponent(`eq.${room.id}`);
  const [feedback, decisions] = await Promise.all([
    cloud.rest("comfort_feedback", `select=id,recorded_at,local_date,season,feeling&room_id=${roomFilter}&order=recorded_at.desc&limit=50`),
    cloud.rest("control_decisions", `select=id,decided_at,desired_temperature,sent,reason,source,queue_command_id&room_id=${roomFilter}&order=decided_at.desc&limit=50`),
  ]);
  $("#history-title").textContent = room.name;
  const feelings = { "-2": "非常冷", "-1": "太冷", "0": "剛好", "1": "太熱", "2": "非常熱" };
  const seasons = { spring: "春季", summer: "夏季", autumn: "秋季", winter: "冬季" };
  const events = [
    ...feedback.map((item) => ({
      at: item.recorded_at,
      title: `回報「${feelings[item.feeling]}」`,
      detail: `${item.local_date || "日期未記錄"} · ${seasons[item.season] || "季節未記錄"} · 已加入個人舒適學習`,
    })),
    ...decisions.map((item) => ({
      at: item.decided_at,
      title: item.sent
        ? `命令已送出 · ${item.desired_temperature}°`
        : item.source === "queue_failed"
        ? `命令 #${item.queue_command_id} 執行失敗`
        : item.source === "queue_full"
        ? "佇列已滿，命令已丟棄"
        : item.source === "queue_unhealthy"
        ? "佇列檢查異常，命令已丟棄"
        : item.queue_command_id
        ? `命令 #${item.queue_command_id} 已排入佇列`
        : "維持目前設定",
      detail: item.reason,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 50);
  const content = $("#history-content");
  content.replaceChildren(...events.map((item) => {
    const row = document.createElement("div"); row.className = "history-item";
    const time = document.createElement("div"); time.className = "history-time";
    time.textContent = new Date(item.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const body = document.createElement("div");
    const title = document.createElement("div"); title.className = "history-title"; title.textContent = item.title;
    const detail = document.createElement("div"); detail.className = "history-detail"; detail.textContent = item.detail;
    body.append(title, detail); row.append(time, body); return row;
  }));
  if (!events.length) content.textContent = "還沒有紀錄。";
  $("#history-dialog").showModal();
}

async function showSettings() {
  $("#rooms-view").classList.add("hidden");
  $("#settings-view").classList.remove("hidden");
  await loadSettings();
}

async function loadSettings() {
  const [choices, insights] = await Promise.all([
    cloud.function("room-choices", {}, "GET"),
    cloud.function("learning-insights", {}, "GET"),
  ]);
  state.roomChoices = choices.rooms;
  state.learning = insights.rooms;
  state.learningContext = insights;
  renderPersonalRoomChoices();
  renderLearning();
  renderAlerts();
  if (!isAdmin()) return;
  const result = await cloud.function("admin-state", {}, "GET");
  state.users = result.members;
  state.allRooms = result.rooms;
  renderSchedules();
  $("#members-list").replaceChildren(
    ...state.users.filter((user) => user.role === "member").map(memberRow),
  );
}

function renderLearning() {
  const list = $("#learning-list");
  const seasons = { spring: "春季", summer: "夏季", autumn: "秋季", winter: "冬季" };
  if (state.learningContext?.current_date) {
    $("#learning-context").textContent =
      `現在是 ${state.learningContext.current_date} · ${seasons[state.learningContext.current_season] || "季節未定"}。MyAmbi 會優先參考相近時段與相近季節的紀錄。`;
  }
  const confidence = { low: "資料不足", medium: "開始穩定", high: "可信度高" };
  const rows = [];
  for (const room of state.learning ?? []) {
    const useful = room.buckets.filter((bucket) => bucket.samples > 0);
    if (!useful.length) {
      const empty = document.createElement("div");
      empty.className = "learning-room";
      empty.innerHTML = `<div><strong></strong><span>還沒有回報；使用房間卡片的太冷、剛好、太熱即可開始學習。</span></div>`;
      empty.querySelector("strong").textContent = room.name;
      rows.push(empty);
      continue;
    }
    for (const bucket of useful) {
      const row = document.createElement("div");
      row.className = "learning-room";
      const direction = bucket.cold > bucket.hot
        ? `較常覺得冷（${bucket.cold} 次）`
        : bucket.hot > bucket.cold
        ? `較常覺得熱（${bucket.hot} 次）`
        : `冷熱回報平衡`;
      row.innerHTML = `
        <div><strong></strong><span>${bucket.label} · ${direction}</span></div>
        <div class="learned-temperature"><small>舒適室溫</small>${bucket.comfort_room_temperature == null ? "—" : `${Number(bucket.comfort_room_temperature).toFixed(1)}°`}</div>
        <div class="learned-temperature"><small>建議冷氣</small>${Number(bucket.recommended_setpoint).toFixed(1)}°</div>
        <div class="confidence ${bucket.confidence}">${confidence[bucket.confidence]} · ${bucket.samples} 筆</div>
      `;
      row.querySelector("strong").textContent = room.name;
      rows.push(row);
    }
  }
  list.replaceChildren(...rows);
  if (!rows.length) list.textContent = "建立房間後，學習報告會顯示在這裡。";
}

function renderAlerts() {
  const list = $("#alerts-list");
  if (!list) return;
  const alerts = state.status?.active_alerts ?? [];
  if (!alerts.length) {
    list.innerHTML = `<div class="health-ok"><span></span>目前沒有未解決的故障</div>`;
    return;
  }
  list.replaceChildren(...alerts.map((alert) => {
    const row = document.createElement("div");
    row.className = `alert-row ${alert.severity}`;
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = alert.severity === "critical" ? "需要處理" : "請留意";
    const message = document.createElement("div");
    message.textContent = alert.message;
    const time = document.createElement("time");
    time.textContent = `${new Date(alert.last_seen_at).toLocaleString("zh-TW")} · 發生 ${alert.occurrence_count} 次`;
    body.append(title, message, time);
    row.append(body);
    return row;
  }));
}

async function maybeNotifyAlerts(force = false) {
  const alerts = state.status?.active_alerts ?? [];
  if (!("Notification" in window) || Notification.permission !== "granted" || !alerts.length) return;
  const storageKey = "myambi.notified-alerts";
  let notified = [];
  try { notified = JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch (_) {}
  const unseen = force ? alerts : alerts.filter((alert) => !notified.includes(alert.id));
  if (!unseen.length) return;
  const registration = await navigator.serviceWorker?.ready;
  for (const alert of unseen.slice(0, 3)) {
    await registration?.showNotification("MyAmbi 冷氣需要注意", {
      body: alert.message,
      icon: "/logo.svg",
      tag: `myambi-alert-${alert.id}`,
      data: { url: "/#settings" },
    });
  }
  localStorage.setItem(storageKey, JSON.stringify(alerts.map((alert) => alert.id).slice(0, 50)));
}

function roomCheck(room, checked) {
  const label = document.createElement("label"); label.className = "check";
  const input = document.createElement("input"); input.type = "checkbox"; input.value = room.id; input.checked = checked;
  const span = document.createElement("span"); span.textContent = room.name;
  label.append(input, span); return label;
}

function renderPersonalRoomChoices() {
  const fieldset = $("#personal-room-choices");
  fieldset.querySelector(".checks")?.remove();
  const checks = document.createElement("div"); checks.className = "checks";
  checks.append(...state.roomChoices.map((room) => roomCheck(room, room.visible)));
  if (!state.roomChoices.length) checks.textContent = "還沒有可選的房間。";
  fieldset.append(checks);
}

function memberRow(member) {
  const row = document.createElement("div"); row.className = "member-row";
  const identity = document.createElement("div");
  const name = document.createElement("div"); name.className = "member-name"; name.textContent = member.display_name;
  const role = document.createElement("div"); role.className = "member-role"; role.textContent = "家庭成員 · 可自行選擇首頁房間";
  identity.append(name, role);
  row.append(identity); return row;
}

function renderSchedules() {
  const list = $("#schedules-list");
  list.replaceChildren(...state.allRooms.map((room) => {
    const form = document.createElement("form");
    form.className = "schedule-row";
    form.dataset.roomId = room.id;
    form.innerHTML = `
      <div class="schedule-room"><strong></strong><span>每日，台北時間</span></div>
      <label class="schedule-toggle"><input name="enabled" type="checkbox" ${room.schedule_enabled ? "checked" : ""}>啟用</label>
      <label>開機<input name="scheduled_on" type="time" value="${String(room.scheduled_on || "21:00").slice(0, 5)}"></label>
      <label>關機<input name="scheduled_off" type="time" value="${String(room.scheduled_off || "08:00").slice(0, 5)}"></label>
      <button class="secondary" type="submit">儲存</button>
    `;
    form.querySelector("strong").textContent = room.name;
    return form;
  }));
  if (!state.allRooms.length) list.textContent = "請先建立或匯入房間。";
}

$("#personal-room-choices").addEventListener("change", async () => {
  const roomIds = [...$("#personal-room-choices").querySelectorAll("input:checked")].map((item) => item.value);
  try {
    await cloud.function("set-visible-rooms", { room_ids: roomIds });
    showToast("你的首頁房間已更新");
    await loadRooms();
  } catch (error) { showToast(error.message, true); }
});

$("#schedules-list").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = event.submitter;
  const values = new FormData(form);
  setBusy(button, true);
  try {
    await cloud.function("schedule", {
      room_id: form.dataset.roomId,
      enabled: values.get("enabled") === "on",
      scheduled_on: values.get("scheduled_on"),
      scheduled_off: values.get("scheduled_off"),
    });
    showToast("開關機時間已儲存");
    await loadSettings();
    await loadRooms();
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await cloud.function("bootstrap", values);
    await boot();
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    $("#auth-error").classList.add("hidden");
    $("#link-sent").classList.add("hidden");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await cloud.sendMagicLink(values.email, values.display_name);
    $("#link-sent").classList.remove("hidden");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#member-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    const form = new FormData(event.currentTarget);
    await cloud.function("invite-member", {
      display_name: form.get("display_name"), email: form.get("email"),
    });
    event.currentTarget.reset(); await loadSettings(); showToast("邀請信已寄出");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#demo-button").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true);
  try { await cloud.function("demo"); await loadRooms(); await loadSettings(); showToast("三個模擬房間已建立"); }
  catch (error) { showToast(error.message, true); }
  finally { setBusy(event.currentTarget, false); }
});

$("#save-key-button").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true);
  try {
    const result = await cloud.function("connect-sensibo", { api_key: $("#sensibo-key").value });
    $("#sensibo-key").value = ""; await loadRooms(); await loadSettings();
    showToast(`連線成功，已匯入 ${result.devices.length} 台 Sensibo`);
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(event.currentTarget, false); }
});

$("#notification-button").addEventListener("click", async (event) => {
  if (!("Notification" in window)) {
    showToast("這個瀏覽器不支援裝置通知；故障仍會顯示在 MyAmbi", true);
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("尚未允許通知；故障仍會保存在 MyAmbi", true);
      return;
    }
    event.currentTarget.textContent = "裝置通知已開啟";
    await maybeNotifyAlerts(true);
    showToast("MyAmbi 故障通知已開啟");
  } catch (_) {
    showToast("請先把 MyAmbi 加到主畫面，再開啟通知", true);
  }
});

$("#settings-button").addEventListener("click", showSettings);
$("#open-settings-empty").addEventListener("click", showSettings);
$("#back-button").addEventListener("click", () => { $("#settings-view").classList.add("hidden"); $("#rooms-view").classList.remove("hidden"); loadRooms(); });
$("#close-history").addEventListener("click", () => $("#history-dialog").close());
$("#logout-button").addEventListener("click", async () => { await cloud.signOut(); location.reload(); });

boot();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
