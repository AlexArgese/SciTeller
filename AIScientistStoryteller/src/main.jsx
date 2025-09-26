import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";

/* IMPORTA PRIMA I TOKENS, POI I GLOBAL */
import "./styles/tokens.css";
import "./styles/global.css";

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
