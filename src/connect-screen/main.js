const form = document.getElementById("connect-form");
const input = document.getElementById("server-url");
const errorEl = document.getElementById("error");
const button = form.querySelector("button");

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

function clearError() {
  errorEl.style.display = "none";
  errorEl.textContent = "";
}

window.argusdeConnect.getServerUrl().then((url) => {
  input.value = url;
});

window.argusdeConnect.onConnectFailed((message) => {
  button.disabled = false;
  showError(message);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  clearError();
  button.disabled = true;
  window.argusdeConnect.setServerUrl(url).then(() => {
    window.argusdeConnect.retryConnect();
  });
});
