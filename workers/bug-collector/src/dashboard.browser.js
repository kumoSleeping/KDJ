"use strict";
const $ = id => document.getElementById(id);
let token = "", next = null, selected = null, busy = false;
const picked = new Set();
function status(message) { $("status").textContent = message; }
async function request(path, init = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) };
  const response = await fetch(path, { ...init, cache: "no-store", headers });
  if (!response.ok) { if (response.status === 401) logout(); throw new Error(`HTTP ${response.status}`); }
  return response.json();
}
function logout() {
  token = ""; selected = null; next = null;
  $("token").value = ""; $("reports").replaceChildren(); $("body").textContent = ""; $("detail").close();
  $("login").hidden = false; $("panel").hidden = true; $("logout").hidden = true;
}
async function run(operation) {
  if (busy) return; busy = true; status("");
  try { await operation(); } catch (error) { status(error.message); } finally { busy = false; }
}
async function load(cursor = "") {
  const result = await request(`/admin/reports?before=${encodeURIComponent(cursor)}&category=${encodeURIComponent($("category").value)}`);
  $("reports").replaceChildren();
  picked.clear(); $("pick-all").checked = false; $("remove-picked").disabled = true;
  for (const report of result.reports) {
    const row = document.createElement("tr");
    const pickCell = document.createElement("td"), pick = document.createElement("input");
    pick.type = "checkbox"; pick.className = "pick"; pick.value = report.id; pick.setAttribute("aria-label", "选择");
    pick.onchange = () => { pick.checked ? picked.add(report.id) : picked.delete(report.id); $("remove-picked").disabled = !picked.size; };
    pickCell.append(pick); row.append(pickCell);
    for (const [value, kind] of [[new Date(report.received_at).toLocaleString(), ""], [`${report.app_version} / ${report.os}`, ""],
      [report.note || "", "note"], [report.top_error || "", "top"], [report.event_count, ""]]) {
      const cell = document.createElement("td"); cell.textContent = String(value); if (kind) cell.className = kind; row.append(cell);
    }
    const cell = document.createElement("td"), button = document.createElement("button");
    button.textContent = report.id.slice(0, 12);
    button.onclick = () => run(async () => {
      selected = await request(`/admin/reports/${report.id}`);
      $("body").textContent = JSON.stringify(selected, null, 2); $("detail").showModal();
    });
    cell.append(button); row.append(cell); $("reports").append(row);
  }
  next = result.next; $("more").hidden = !next;
  $("login").hidden = true; $("panel").hidden = false; $("logout").hidden = false;
}
$("connect").onclick = () => run(async () => { token = $("token").value.trim(); $("token").value = ""; await load(); });
$("token").onkeydown = event => { if (event.key === "Enter") $("connect").click(); };
$("logout").onclick = logout;
$("refresh").onclick = () => run(() => load());
$("category").onchange = () => run(() => load());
$("more").onclick = () => run(() => load(next ?? ""));
$("close").onclick = () => $("detail").close();
$("delete").onclick = () => run(async () => {
  if (!selected || !confirm("永久删除这份报告？")) return;
  await request(`/admin/reports/${selected.id}`, { method: "DELETE" });
  selected = null; $("body").textContent = ""; $("detail").close(); await load();
});
$("pick-all").onchange = () => {
  for (const pick of document.querySelectorAll("input.pick")) {
    pick.checked = $("pick-all").checked;
    pick.checked ? picked.add(pick.value) : picked.delete(pick.value);
  }
  $("remove-picked").disabled = !picked.size;
};
$("remove-picked").onclick = () => run(async () => {
  if (!picked.size || !confirm(`永久删除所选的 ${picked.size} 份报告？`)) return;
  const result = await request("/admin/reports/delete", { method: "POST", body: JSON.stringify({ ids: [...picked] }) });
  await load(); status(`已删除 ${result.deleted} 份`);
});
$("remove-below").onclick = () => run(async () => {
  const below = $("below").value.trim();
  if (!below || !confirm(`永久删除版本低于 ${below} 的全部报告？`)) return;
  const result = await request("/admin/reports/delete", { method: "POST", body: JSON.stringify({ below }) });
  await load(); status(`已删除 ${result.deleted} 份`);
});
$("download").onclick = () => {
  if (!selected) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `kdj-report-${selected.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
