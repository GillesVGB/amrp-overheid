export const wallpaperOptions = [
  {
    id: "bloom",
    label: "Windows 11 Bloom",
    detail: "Blauwe standaardachtergrond",
  },
  {
    id: "classic",
    label: "Windows klassiek",
    detail: "Lichtblauwe Windows-achtergrond",
  },
  {
    id: "midnight",
    label: "Middernacht",
    detail: "Donkere achtergrond met blauwe gloed",
  },
  {
    id: "amsterdam",
    label: "Amsterdam",
    detail: "Stedelijk blauw kleurverloop",
  },
  {
    id: "amsterdamrp",
    label: "Amsterdam Roleplay",
    detail: "De Amsterdamse grachten bij zonsondergang",
  },
];
export const themeOptions = [
  { id: "light", label: "Licht", detail: "Lichte vensters en menu’s" },
  { id: "dark", label: "Zwart", detail: "Donkere vensters, menu’s en apps" },
];

// The account preference is authoritative; local storage only speeds up display.
export function applyAppearance(value) {
  const wallpaper = wallpaperOptions.some(
    (option) => option.id === value?.wallpaper,
  )
    ? value.wallpaper
    : "bloom";
  const theme = themeOptions.some((option) => option.id === value?.theme)
    ? value.theme
    : "light";
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll(".wallpaper").forEach((element) => {
    element.dataset.wallpaper = wallpaper;
  });
  try {
    localStorage.setItem("amrp-wallpaper", wallpaper);
    localStorage.setItem("amrp-theme", theme);
  } catch {
    /* Server preferences also work when browser storage is disabled. */
  }
  return { wallpaper, theme };
}

export function restoreAppearance() {
  try {
    return applyAppearance({
      wallpaper: localStorage.getItem("amrp-wallpaper"),
      theme: localStorage.getItem("amrp-theme"),
    });
  } catch {
    return applyAppearance({});
  }
}
