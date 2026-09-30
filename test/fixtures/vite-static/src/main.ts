import "./style.css";

// A build-time value: compiled into the bundle by `vite build`, not read at runtime.
const api = import.meta.env.VITE_API_URL ?? "(not set)";

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `<h1>Vite static fixture</h1><p id="api">API: ${api}</p>`;
