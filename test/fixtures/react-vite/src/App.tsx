import { Link, Route, Routes } from "react-router";
import About from "./pages/About";
import User from "./pages/User";

// Build-time values: Vite replaces these while bundling, so they are fixed per image.
const apiUrl = import.meta.env.VITE_API_URL ?? "(VITE_API_URL not set at build time)";

export default function App() {
  return (
    <main>
      <h1>{import.meta.env.VITE_APP_TITLE}</h1>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link> <Link to="/users/123">User 123</Link>
      </nav>
      <Routes>
        <Route path="/" element={<p>fixture-react-vite home, API at {apiUrl}</p>} />
        <Route path="/about" element={<About />} />
        <Route path="/users/:id" element={<User />} />
      </Routes>
    </main>
  );
}
