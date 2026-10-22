# TypeScript workbench design

Use the editor as the main surface. A light warm shell holds the project identity, action toolbar and save-point strip. A dark green workspace contains the file explorer, source tabs, Monaco editor and bottom panel. Manrope labels and JetBrains Mono code follow the existing app's typography.

Compile & Run is the primary green button. Compile and Run remain separate for inspecting emitted JavaScript. Save point and Restore sit alongside them. Stop & restore appears during commands. Disable mutation controls while busy; generated files remain read-only.

The save-point strip names the checkpoint, generation and source revision. Dirty buffers show a dot and invalidate Run immediately. Compiler diagnostics identify their checked revision. Prior output and generated files remain inspectable with stale labels after edits or failed compilation.

The lower panel offers Node output, Problems and Changes. Failed compilation opens Problems. Caller permissions are an advanced explorer disclosure. Runtime limits and shared-workspace ownership are explained below the main surface.

At narrow widths, let toolbar actions wrap and stack the explorer above the editor. Preserve code scrolling, legible controls and a useful output panel. Keyboard focus must remain visible. Monaco instances, models and listeners are disposed on unmount.
