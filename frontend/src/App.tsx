import { Routes, Route } from "react-router";
import HomePage from "./pages/HomePage";
import RoomPage from "./pages/RoomPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/r/:slug" element={<RoomPage />} />
    </Routes>
  );
}
