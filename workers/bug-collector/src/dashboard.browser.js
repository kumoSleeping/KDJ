"use strict";
const $ = id => document.getElementById(id);
let token = "", next = null, selected = null, busy = false;
function status(message) { $("status").textContent = message; }
async function request(path, init = {}) {
  const response = await fetch(path, { ...init, cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
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
  for (const report of result.reports) {
    const row = document.createElement("tr");
    for (const value of [new Date(report.received_at).toLocaleString(), `${report.app_version} / ${report.os}`, report.categories, report.event_count]) {
      const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell);
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
$("download").onclick = () => {
  if (!selected) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `kdj-report-${selected.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
