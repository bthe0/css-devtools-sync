/**
 * Tier: Tailwind utility classes (class-list diff).
 * There is NO stylesheet to edit for this component — DevTools edits map to
 * class-list changes, and the sync server rewrites the className strings in
 * THIS file (e.g. bg-indigo-600 -> bg-emerald-600, p-8 -> p-12).
 */
export function TailwindHero() {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-800 p-8 shadow-xl">
      <p className="mb-2 text-xs font-bold uppercase tracking-widest text-indigo-200">
        Preview environment
      </p>
      <h3 className="mb-3 text-3xl font-extrabold text-white">
        Ship styles without leaving DevTools
      </h3>
      <p className="mb-6 max-w-md text-sm leading-relaxed text-indigo-100">
        Tweak a utility in the Elements panel, hit Sync, and the class list in
        TailwindHero.tsx updates to match. No copy-paste, no drift.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
        >
          Get started
        </button>
        <button
          type="button"
          className="rounded-lg border border-indigo-300 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500/30"
        >
          Read docs
        </button>
      </div>
    </div>
  );
}
