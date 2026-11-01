/** Inline script that applies the saved theme before first paint (avoids a light flash in dark mode). */
export const themeScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
