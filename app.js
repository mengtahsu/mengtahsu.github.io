const cloud = new window.MyAmbiCloud(window.MYAMBI_CONFIG);
const state = { status: null, user: null, households: [], rooms: [], queue: [], users: [], allRooms: [], roomChoices: [], learning: [], learningContext: null, historyRoom: null, historyReadings: [], historyEvents: [], historyDays: 1, historyZoom: 1, refreshTimer: null };
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
  $("#password-reset-form").classList.toggle("hidden", mode !== "password-reset");
  $("#password-set-done").classList.toggle("hidden", mode !== "password-set-done");
  const trusted = mode === "login" && cloud.hasTrustedDevice();
  $("#trusted-device-login").classList.toggle("hidden", !trusted);
  $("#trusted-device-copy").classList.toggle("hidden", !trusted);
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

function renderHouseholds() {
  const switcher = $("#household-switcher");
  switcher.replaceChildren(...state.households.map((household) => {
    const option = document.createElement("option");
    option.value = household.id;
    option.textContent = household.name;
    option.selected = household.id === cloud.activeHouseholdId;
    return option;
  }));
  const active = state.households.find((household) => household.id === cloud.activeHouseholdId);
  $("#current-house-label").textContent = active ? `現在的家 · ${active.name}` : "現在的家";
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
    if (cloud.callbackType === "recovery" || new URLSearchParams(location.search).get("password-reset") === "1") {
      history.replaceState({}, document.title, location.pathname);
      return showAuth("password-reset");
    }
    const householdResult = await cloud.function("households", {}, "GET");
    state.households = householdResult.households ?? [];
    if (!state.households.length) return showAuth("setup");
    const activeStillExists = state.households.some((item) => item.id === cloud.activeHouseholdId);
    if (!activeStillExists) cloud.setActiveHousehold(state.households[0].id);
    state.status = await cloud.function("status", {}, "GET");
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    hideBoot();
    $("#user-name").textContent = displayName();
    renderHouseholds();
    applyRole();
    await loadRooms();
    if (location.hash === "#settings") await showSettings();
    else showRooms(false);
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(loadRooms, 15000);
  } catch (error) {
    showAuth("login");
    $("#auth-error").textContent = `登入沒有完成：${error.message}。請重新整理或重新寄登入信。`;
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
    if (!cloud.activeHouseholdId) return;
    const [rooms, status, queue] = await Promise.all([
      cloud.rest("room_dashboard", `select=*&household_id=eq.${cloud.activeHouseholdId}&order=name.asc`),
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
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  const roomPresence = (state.status?.presence ?? []).filter((presence) => presence.room_id === room.id);
  const mePresent = roomPresence.some((presence) => presence.user_id === state.user?.id);
  const presenceNames = roomPresence.map((presence) => presence.display_name).join("、");
  article.innerHTML = `
    <div class="room-head"><h2></h2><span class="room-state ${isOn ? "" : "off"}">${room.observed_at ? (isOn ? "運轉中" : "已關閉") : "等待同步"}</span></div>
    <div class="temperature">${displayNumber(room.temperature, 1)}<sup>°</sup></div>
    <div class="climate-meta"><span>濕度 ${displayNumber(room.humidity)}%</span>${numericValue(room.outdoor_temperature) !== null ? `<span>室外 ${displayNumber(room.outdoor_temperature, 1)}°</span>` : ""}<span>${room.mode || "—"}</span></div>
    <div class="target-row">
      <span>冷氣目前設定 <b class="target-value">${displayNumber(room.target_temperature)}°</b></span>
      <small>${isOn ? "MyAmbi 依室溫與你的感覺自動調整" : "關機安全鎖已啟用"}</small>
    </div>
    <p class="feeling-label">你現在感覺如何？</p>
    <div class="feelings">
      <button class="feeling" data-feeling="-2"><span>🥶</span>太冷</button>
      <button class="feeling" data-feeling="-1"><span>😣</span>有點冷</button>
      <button class="feeling" data-feeling="0"><span>😌</span>剛好</button>
      <button class="feeling" data-feeling="1"><span>😓</span>有點熱</button>
      <button class="feeling" data-feeling="2"><span>🥵</span>太熱</button>
    </div>
    <div class="presence-row">
      <span>${presenceNames ? `目前在房：${presenceNames}` : "尚未確認誰在房"}</span>
      <button class="room-action ${mePresent ? "presence-leave" : "presence-arrive"}">${mePresent ? "我離開了" : "我在這裡"}</button>
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
    } else if (event.target.matches(".history")) {
      await showHistory(room);
    } else if (event.target.matches(".presence-arrive, .presence-leave")) {
      const present = event.target.matches(".presence-arrive");
      const result = await cloud.function("presence", { room_id: roomId, present });
      showToast(present
        ? `已登記在房；到 ${new Date(result.expires_at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 前有效`
        : "已登記離開，後續不再以你的即時偏好為主");
    } else if (event.target.matches(".auto-toggle")) {
      await cloud.function("automation", { room_id: roomId, enabled: !room.automation_enabled });
      showToast(room.automation_enabled ? "已暫停自動控制" : "已啟用自動控制");
    }
    await loadRooms();
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(event.target, false); }
});

async function showHistory(room, days = 1) {
  const roomFilter = encodeURIComponent(`eq.${room.id}`);
  const [feedback, decisions, climate] = await Promise.all([
    cloud.rest("comfort_feedback", `select=id,user_id,recorded_at,local_date,season,feeling,snapshot&room_id=${roomFilter}&order=recorded_at.desc&limit=50`),
    cloud.rest("control_decisions", `select=id,decided_at,desired_temperature,sent,reason,source,queue_command_id&room_id=${roomFilter}&order=decided_at.desc&limit=50`),
    cloud.function("climate-history", { room_id: room.id, days }),
  ]);
  const userIds = [...new Set(feedback.map((item) => item.user_id).filter(Boolean))];
  const profiles = userIds.length
    ? await cloud.rest("profiles", `select=id,display_name&id=in.(${userIds.join(",")})`)
    : [];
  const profileNames = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
  $("#history-title").textContent = room.name;
  const feelings = { "-2": "太冷", "-1": "有點冷", "0": "剛好", "1": "有點熱", "2": "太熱" };
  const seasons = { spring: "春季", summer: "夏季", autumn: "秋季", winter: "冬季" };
  const events = [
    ...feedback.map((item) => ({
      at: item.recorded_at,
      title: `${profileNames.get(item.user_id) || "家庭成員"}回報「${feelings[item.feeling]}」`,
      detail: `${room.name} · ${item.local_date || "日期未記錄"} · ${seasons[item.season] || "季節未記錄"} · 室溫 ${displayNumber(item.snapshot?.temperature, 1)}° · 室外 ${displayNumber(item.snapshot?.outdoor_temperature, 1)}° · 濕度 ${displayNumber(item.snapshot?.humidity)}%`,
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
  state.historyRoom = room;
  state.historyReadings = climate.readings ?? [];
  state.historyEvents = events;
  state.historyDays = Number(climate.days ?? days);
  renderHistoryContent();
  if (!$("#history-dialog").open) $("#history-dialog").showModal();
}

function historyEventRows(events) {
  return events.map((item) => {
    const row = document.createElement("div"); row.className = "history-item";
    const time = document.createElement("div"); time.className = "history-time";
    time.textContent = new Date(item.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const body = document.createElement("div");
    const title = document.createElement("div"); title.className = "history-title"; title.textContent = item.title;
    const detail = document.createElement("div"); detail.className = "history-detail"; detail.textContent = item.detail;
    body.append(title, detail); row.append(time, body); return row;
  });

}

function renderHistoryContent() {
  const content = $("#history-content");
  const chart = climateChart(state.historyReadings, state.historyDays, state.historyZoom);
  const eventRows = historyEventRows(state.historyEvents);
  content.replaceChildren(chart, ...eventRows);
  if (!state.historyEvents.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "還沒有操作或體感紀錄。";
    content.append(empty);
  }
}

function climateChart(rawReadings, days = 1, zoom = 1) {
  const section = document.createElement("section");
  section.className = "climate-chart";
  const heading = document.createElement("div");
  heading.className = "chart-heading";
  const rangeLabel = days === 1 ? "24 小時" : `${days} 天`;
  heading.innerHTML = `<strong>房間環境曲線</strong><span>最近 ${rangeLabel} · 左軸 °C，右軸濕度</span>`;
  section.append(heading);

  const toolbar = document.createElement("div");
  toolbar.className = "chart-toolbar";
  toolbar.innerHTML = `
    <div class="chart-ranges" aria-label="圖表時間範圍">
      <button type="button" data-history-days="1" class="${days === 1 ? "active" : ""}">24h</button>
      <button type="button" data-history-days="7" class="${days === 7 ? "active" : ""}">7 天</button>
      <button type="button" data-history-days="30" class="${days === 30 ? "active" : ""}">30 天</button>
    </div>
    <div class="chart-tools">
      <button type="button" data-chart-zoom="out" aria-label="縮小圖表">−</button>
      <span>${Math.round(zoom * 100)}%</span>
      <button type="button" data-chart-zoom="in" aria-label="放大圖表">＋</button>
      <button type="button" data-chart-download>下載 CSV</button>
    </div>`;
  section.append(toolbar);

  const readings = rawReadings
    .filter((row) => Number.isFinite(new Date(row.observed_at).getTime()))
    .sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at));
  if (readings.length < 2) {
    const empty = document.createElement("p");
    empty.textContent = "累積兩筆環境資料後就會顯示曲線。";
    section.append(empty);
    return section;
  }

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 760 300");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "室內、室外、冷氣設定溫度與濕度隨時間變化");
  const margin = { left: 44, right: 44, top: 20, bottom: 34 };
  const plotWidth = 760 - margin.left - margin.right;
  const plotHeight = 300 - margin.top - margin.bottom;
  const times = readings.map((row) => new Date(row.observed_at).getTime());
  const start = Math.min(...times);
  const end = Math.max(...times);
  const timeSpan = Math.max(1, end - start);
  const temperatureValues = readings.flatMap((row) => [
    numericValue(row.temperature),
    numericValue(row.outdoor_temperature),
    numericValue(row.target_temperature),
  ]).filter((value) => value !== null);
  if (!temperatureValues.length) {
    const empty = document.createElement("p");
    empty.textContent = "目前沒有可畫出的溫度資料。";
    section.append(empty);
    return section;
  }
  let temperatureMin = Math.floor(Math.min(...temperatureValues) - 1);
  let temperatureMax = Math.ceil(Math.max(...temperatureValues) + 1);
  if (temperatureMax === temperatureMin) temperatureMax += 1;
  const x = (at) => margin.left + (at - start) / timeSpan * plotWidth;
  const yTemperature = (value) => margin.top + (temperatureMax - value) / (temperatureMax - temperatureMin) * plotHeight;
  const yHumidity = (value) => margin.top + (100 - value) / 100 * plotHeight;

  const line = (x1, y1, x2, y2, className) => {
    const element = document.createElementNS(svgNS, "line");
    Object.entries({ x1, y1, x2, y2 }).forEach(([key, value]) => element.setAttribute(key, String(value)));
    element.setAttribute("class", className);
    svg.append(element);
  };
  const label = (value, xValue, yValue, anchor = "end") => {
    const element = document.createElementNS(svgNS, "text");
    element.textContent = value;
    element.setAttribute("x", String(xValue));
    element.setAttribute("y", String(yValue));
    element.setAttribute("text-anchor", anchor);
    element.setAttribute("class", "chart-axis-label");
    svg.append(element);
  };
  for (let index = 0; index <= 4; index += 1) {
    const y = margin.top + plotHeight * index / 4;
    const temp = temperatureMax - (temperatureMax - temperatureMin) * index / 4;
    line(margin.left, y, margin.left + plotWidth, y, "chart-gridline");
    label(`${temp.toFixed(0)}°`, margin.left - 7, y + 4);
    label(`${100 - index * 25}%`, 760 - margin.right + 7, y + 4, "start");
  }
  const timeFormat = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit" });
  [0, 0.5, 1].forEach((position) => {
    const at = start + timeSpan * position;
    label(timeFormat.format(new Date(at)), x(at), 294, position === 0 ? "start" : position === 1 ? "middle" : "end");
  });

  const addPath = (key, y, className) => {
    let pathData = "";
    let drawing = false;
    readings.forEach((row) => {
      const value = numericValue(row[key]);
      if (value === null) {
        drawing = false;
        return;
      }
      pathData += `${drawing ? "L" : "M"}${x(new Date(row.observed_at).getTime()).toFixed(1)},${y(value).toFixed(1)} `;
      drawing = true;
    });
    if (!pathData) return;
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("class", `chart-series ${className}`);
    svg.append(path);
  };
  addPath("temperature", yTemperature, "indoor");
  addPath("outdoor_temperature", yTemperature, "outdoor");
  addPath("target_temperature", yTemperature, "target");
  addPath("humidity", yHumidity, "humidity");
  svg.style.width = `${Math.round(zoom * 100)}%`;
  const viewport = document.createElement("div");
  viewport.className = "chart-viewport";
  viewport.append(svg);
  section.append(viewport);

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  [["indoor", "室內溫度"], ["outdoor", "室外溫度"], ["target", "冷氣設定"], ["humidity", "室內濕度"]].forEach(([className, text]) => {
    const item = document.createElement("span");
    item.innerHTML = `<i class="${className}"></i>${text}`;
    legend.append(item);
  });
  section.append(legend);
  return section;
}

function downloadHistoryCsv() {
  if (!state.historyRoom || !state.historyReadings.length) return showToast("目前沒有可下載的資料", true);
  const columns = ["observed_at", "temperature", "outdoor_temperature", "target_temperature", "humidity", "outdoor_humidity", "is_on"];
  const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [columns.join(","), ...state.historyReadings.map((row) => columns.map((key) => escapeCsv(row[key])).join(","))].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
  link.download = `MyAmbi-${state.historyRoom.name}-${state.historyDays}d.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function updateNavigation(view) {
  $("#rooms-nav").classList.toggle("active", view === "rooms");
  $("#settings-nav").classList.toggle("active", view === "settings");
}

function showRooms(updateHash = true) {
  $("#history-dialog").open && $("#history-dialog").close();
  $("#settings-view").classList.add("hidden");
  $("#rooms-view").classList.remove("hidden");
  updateNavigation("rooms");
  if (updateHash) history.replaceState({}, document.title, `${location.pathname}#rooms`);
  loadRooms();
}

async function showSettings() {
  $("#history-dialog").open && $("#history-dialog").close();
  $("#rooms-view").classList.add("hidden");
  $("#settings-view").classList.remove("hidden");
  updateNavigation("settings");
  history.replaceState({}, document.title, `${location.pathname}#settings`);
  try { await loadSettings(); }
  catch (error) { showToast(`設定讀取失敗：${error.message}`, true); }
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
  renderLocations();
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
    const thermal = room.thermal_model ?? {};
    const thermalRow = document.createElement("div");
    thermalRow.className = "learning-room thermal-room";
    const cooling = numericValue(thermal.cooling_rate_per_hour);
    const warming = numericValue(thermal.warming_rate_per_hour);
    thermalRow.innerHTML = `
      <div><strong></strong><span>房間熱力模型 · 依實測室溫變化與相近室外天氣學習</span></div>
      <div class="learned-temperature"><small>降溫速度</small>${cooling === null ? "蒐集中" : `${cooling.toFixed(2)}°/時`}</div>
      <div class="learned-temperature"><small>升溫速度</small>${warming === null ? "蒐集中" : `${warming.toFixed(2)}°/時`}</div>
      <div class="confidence ${cooling !== null && warming !== null ? "high" : cooling !== null || warming !== null ? "medium" : ""}">降溫 ${Number(thermal.cooling_samples || 0)} 段 · 升溫 ${Number(thermal.warming_samples || 0)} 段</div>`;
    thermalRow.querySelector("strong").textContent = room.name;
    rows.push(thermalRow);
    const useful = room.buckets.filter((bucket) => bucket.samples > 0);
    if (!useful.length) {
      const empty = document.createElement("div");
      empty.className = "learning-room";
      empty.innerHTML = `<div><strong></strong><span>還沒有回報；使用房間卡片的有點冷、剛好、有點熱即可開始學習。</span></div>`;
      empty.querySelector("strong").textContent = room.name;
      rows.push(empty);
      continue;
    }
    for (const [bucketIndex, bucket] of useful.entries()) {
      const row = document.createElement("div");
      row.className = "learning-room";
      const direction = bucket.cold > bucket.hot
        ? `較常覺得冷（${bucket.cold} 次）`
        : bucket.hot > bucket.cold
        ? `較常覺得熱（${bucket.hot} 次）`
        : `冷熱回報平衡`;
      const coldTiming = bucketIndex === 0 && room.usual_cold_times?.length
        ? ` · 常見覺冷時間 ${room.usual_cold_times.join("、")}`
        : "";
      row.innerHTML = `
        <div><strong></strong><span>${bucket.label} · ${direction}${coldTiming} · 濕度體感修正 ${Number(bucket.humidity_correction) >= 0 ? "+" : ""}${Number(bucket.humidity_correction || 0).toFixed(1)}°</span></div>
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

function renderLocations() {
  const supported = state.allRooms.some((room) => Object.hasOwn(room, "location_label"));
  $("#location-panel").classList.toggle("hidden", !supported);
  if (!supported) return;
  const list = $("#locations-list");
  list.replaceChildren(...state.allRooms.map((room) => {
    const form = document.createElement("form");
    form.className = "location-row";
    form.dataset.roomId = room.id;
    const identity = document.createElement("div");
    identity.className = "location-room";
    const name = document.createElement("strong");
    name.textContent = room.name;
    const saved = document.createElement("span");
    saved.textContent = room.location_label || "尚未設定位置";
    identity.append(name, saved);
    const label = document.createElement("label");
    label.textContent = "縣市／行政區";
    const input = document.createElement("input");
    input.name = "location";
    input.required = true;
    input.maxLength = 200;
    input.placeholder = "例如：台北市大安區";
    input.value = room.location_label || "";
    label.append(input);
    const button = document.createElement("button");
    button.className = "secondary";
    button.type = "submit";
    button.textContent = "儲存位置";
    form.append(identity, label, button);
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

$("#locations-list").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = event.submitter;
  const values = new FormData(form);
  setBusy(button, true);
  try {
    const result = await cloud.function("location", {
      room_id: form.dataset.roomId,
      location: values.get("location"),
    });
    showToast(`已設定為 ${result.label}`);
    await loadSettings();
    await loadRooms();
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const created = await cloud.function("bootstrap", values);
    cloud.setActiveHousehold(created.household_id);
    await boot();
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#new-household-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const created = await cloud.function("bootstrap", {
      household_name: values.household_name,
      display_name: displayName(),
    });
    cloud.setActiveHousehold(created.household_id);
    event.currentTarget.reset();
    await boot();
    showToast("新的家已建立");
  } catch (error) { showToast(error.message, true); }
  finally { setBusy(button, false); }
});

$("#household-switcher").addEventListener("change", async (event) => {
  cloud.setActiveHousehold(event.currentTarget.value);
  clearInterval(state.refreshTimer);
  await boot();
  showToast("已切換目前的家");
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    $("#auth-error").classList.add("hidden");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await cloud.signInWithPassword(values.email, values.password);
    event.currentTarget.reset();
    await boot();
  } catch (error) {
    $("#auth-error").textContent = "Email 或密碼不正確；如果還沒設定密碼，請按下方的設定密碼。";
    $("#auth-error").classList.remove("hidden");
  }
  finally { setBusy(button, false); }
});

$("#request-password-reset").addEventListener("click", async (event) => {
  const email = new FormData($("#login-form")).get("email");
  if (!email) return showToast("請先輸入 Email", true);
  setBusy(event.currentTarget, true);
  try {
    await cloud.sendPasswordReset(email);
    showToast("設定密碼信已寄出；請到 Email 點確認連結");
  } catch (error) { showToast(`無法寄信：${error.message}`, true); }
  finally { setBusy(event.currentTarget, false); }
});

$("#password-reset-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.password !== values.password_confirm) throw new Error("兩次輸入的密碼不同");
    await cloud.updatePassword(values.password);
    event.currentTarget.reset();
    showAuth("password-set-done");
  } catch (error) {
    $("#password-reset-error").textContent = error.message;
    $("#password-reset-error").classList.remove("hidden");
  } finally { setBusy(button, false); }
});

$("#trusted-device-login").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true);
  try {
    await cloud.restoreDevice();
    await boot();
  } catch (error) { showToast(`無法登入：${error.message}`, true); }
  finally { setBusy(event.currentTarget, false); }
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
$("#settings-nav").addEventListener("click", showSettings);
$("#rooms-nav").addEventListener("click", () => showRooms());
$("#brand-home").addEventListener("click", () => showRooms());
$("#open-settings-empty").addEventListener("click", showSettings);
$("#back-button").addEventListener("click", () => showRooms());
window.addEventListener("hashchange", () => {
  if ($("#app-view").classList.contains("hidden")) return;
  if (location.hash === "#settings") showSettings();
  else if (location.hash === "#rooms") showRooms(false);
});
$("#close-history").addEventListener("click", () => $("#history-dialog").close());
$("#history-content").addEventListener("click", async (event) => {
  const range = event.target.closest("[data-history-days]");
  if (range && state.historyRoom) {
    try {
      setBusy(range, true);
      await showHistory(state.historyRoom, Number(range.dataset.historyDays));
    } catch (error) { showToast(error.message, true); }
    finally { setBusy(range, false); }
    return;
  }
  const zoom = event.target.closest("[data-chart-zoom]");
  if (zoom) {
    const step = zoom.dataset.chartZoom === "in" ? 0.5 : -0.5;
    state.historyZoom = Math.max(1, Math.min(4, state.historyZoom + step));
    renderHistoryContent();
    return;
  }
  if (event.target.closest("[data-chart-download]")) downloadHistoryCsv();
});
$("#logout-button").addEventListener("click", async () => {
  await cloud.signOut();
  location.reload();
});

boot();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    location.reload();
  });
  navigator.serviceWorker.register("/sw.js?v=18").then((registration) => registration.update()).catch(() => {});
}
