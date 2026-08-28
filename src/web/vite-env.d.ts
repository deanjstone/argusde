/// <reference types="vite/client" />

// Brings in Vite's ambient module declarations — chiefly `*.css`, which the
// terminal imports dynamically alongside xterm (see lib/xterm-terminal.ts).
// The app's own stylesheet is imported from main.tsx and never needed a
// declaration because it is only ever a side-effect import at the entry
// point; a dynamic `import()` of one is a real module expression.
