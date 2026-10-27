// bb-plugin-sshfs — frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled).
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SshFsPage } from "./components/sshfs-page";
import { RemoteFileEditor } from "./components/file-editor";

export default definePluginApp((app) => {
  // "SSH FS" page: mount list + remote file browser.
  app.slots.navPanel({
    id: "sshfs",
    title: "SSH FS",
    icon: "Globe",
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