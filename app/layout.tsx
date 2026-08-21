import type { Metadata } from "next";
import { Inter, Noto_Sans_Mono } from "next/font/google";
// katex.min.css is loaded on demand alongside rehype-katex (lib/markdown.ts);
// importing it here made it a render-blocking first-load stylesheet.
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RainCode",
  description: "RainCode interface for the pi coding agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${inter.variable} ${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var M=[["pi-theme-mode","raincode-theme-mode"],["pi-theme","raincode-theme"],["pi-appearance","raincode-appearance"],["pi-locale","raincode-locale"],["pi-sound-enabled","raincode-sound-enabled"],["pi-terminal-font","raincode-terminal-font"],["pi-explorer-open","raincode-explorer-open"],["pi-right-panel-width","raincode-right-panel-width"],["pi-sidebar-width","raincode-sidebar-width"],["pi-web:unread-session-ids","raincode:unread-session-ids"],["pi-web-ext-widget-open","raincode-ext-widget-open"]];for(var i=0;i<M.length;i++){var v0=localStorage.getItem(M[i][0]);if(v0!==null){if(localStorage.getItem(M[i][1])===null)localStorage.setItem(M[i][1],v0);localStorage.removeItem(M[i][0])}}var m=localStorage.getItem("raincode-theme-mode");var t=localStorage.getItem("raincode-theme");var dark=false;if(m==="dark"||t==="dark")dark=true;else if(m==="light"||t==="light")dark=false;else dark=!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(dark)document.documentElement.classList.add("dark");var a=localStorage.getItem("raincode-appearance");if(a){try{var p=JSON.parse(a);if(p&&p.uiFontSize)document.documentElement.style.setProperty("--ui-font-size",p.uiFontSize+"px")}catch(_){}}var l=localStorage.getItem("raincode-locale");if(l==="zh"||l==="en")document.documentElement.lang=l;else{var n=(navigator.language||"").toLowerCase();document.documentElement.lang=n.indexOf("zh")===0?"zh":"en"}if(window.raincodeDesktop&&window.raincodeDesktop.isDesktop){var r=document.documentElement;r.classList.add("raincode-desktop");var plat=window.raincodeDesktop.platform;if(plat==="darwin")r.classList.add("raincode-desktop-mac");else if(plat==="win32")r.classList.add("raincode-desktop-win");else if(plat==="linux")r.classList.add("raincode-desktop-linux");if(typeof window.raincodeDesktop.setTheme==="function"){window.raincodeDesktop.setTheme(r.classList.contains("dark")?"dark":"light")}}}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
