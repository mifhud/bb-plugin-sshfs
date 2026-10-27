// bb-plugin-sshfs — frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled).
import type { ComponentType } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SshFsPage } from "./components/sshfs-page";
import { RemoteFileEditor } from "./components/file-editor";

// Floppy-disk glyph the BB host icon set lacks; registered so the editor can
// render `Icon name="Save"` (unknown names would fall back to the host's Zap).
const SaveGlyph: ComponentType<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
    <rect x="8.5" y="3.5" width="7" height="4.5" rx="1" />
    <rect x="6.5" y="11" width="11" height="9.5" rx="1.5" />
    <path d="M9.5 13.5h2" />
  </svg>
);

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "Save", component: SaveGlyph });

  // "SSH FS" page: mount list + remote file browser.
  app.slots.navPanel({
    id: "sshfs",
    title: "SSH FS",
    icon: "Terminal",
    path: "mounts",
    component: SshFsPage,
  });

  // "Remote file" editor tab, opened from the browser with
  // `{ mount, path }` params or from a deep link subPath when a mount is
  // connected.
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "sshfs" },
    availability: "action",
    id: "editor",
    title: "Remote file",
    icon: "EditFile",
    component: RemoteFileEditor,
  });
});