// What a tab does when the server says it's from another build (a deploy happened): reload
// once to get the new build; if this tab already reloaded for that build and is still out of
// date (a cached page, a deploy mid-load), offer the reload instead of looping.

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function outdatedAction(build: string, storage: Storage): "reload" | "offer" {
  const key = `mapcro:reloaded-for:${build}`;
  try {
    if (storage.getItem(key)) return "offer";
    storage.setItem(key, "1");
  } catch {
    return "offer";
  }
  return "reload";
}
