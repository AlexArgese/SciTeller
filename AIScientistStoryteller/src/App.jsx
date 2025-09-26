import { Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar.jsx";
import Footer from "./components/Footer.jsx";
import Home from "./pages/Home.jsx";
import Stories from "./pages/Stories.jsx";
import About from "./pages/About.jsx";
import Login from "./pages/Login.jsx";
import { useEffect } from 'react';

export default function App() {
  useEffect(() => {
    const root = document.body;
    const onMove = e => {
      const x = (e.clientX / window.innerWidth) * 100;
      const y = (e.clientY / window.innerHeight) * 100;
      root.style.setProperty('--lx', x.toFixed(2) + '%');
      root.style.setProperty('--ly', y.toFixed(2) + '%');
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);
  
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/stories" element={<Stories />} />
        <Route path="/about" element={<About />} />
        <Route path="/login" element={<Login />} /> 
      </Routes>
      <Footer />
    </>
  );
}
