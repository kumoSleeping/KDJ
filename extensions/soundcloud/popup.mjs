import { connectSession } from "./session.mjs";

const form = document.querySelector("#connect");
const input = document.querySelector("#code");
const button = form.querySelector("button");
const status = document.querySelector("#status");
form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = "正在连接";
  const code = input.value;
  input.value = "";
  try {
    await connectSession(code, chrome.cookies);
    status.textContent = "已连接 KDJ";
  } catch (error) {
    // Known local errors contain no credentials; browser/network errors are deliberately generic.
    status.textContent = error instanceof TypeError || error?.name === "TimeoutError"
      ? "无法连接本机 KDJ，请重新生成配对码后重试"
      : error.message;
  } finally {
    button.disabled = false;
  }
});
