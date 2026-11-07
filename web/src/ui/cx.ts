/**
 * Class names from parts; falsy parts drop out. Used instead of Solid's `classList` next to a
 * dynamic `class`, where the `class` update overwrites what `classList` added (journal, slice 3).
 */
export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
