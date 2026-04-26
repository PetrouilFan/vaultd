import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_SETTINGS } from './types';
import type { SyncSettings } from './types';

export class SyncSettingTab extends PluginSettingTab {
  plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Tailnet Sync Settings' });

    let settings = DEFAULT_SETTINGS;
    try {
      settings = { ...DEFAULT_SETTINGS, ...(this.plugin as any).settings };
    } catch {}

    // Server URL
    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket server URL (e.g. ws://100.106.178.69:8081)')
      .addText((text) =>
        text
          .setPlaceholder('ws://100.106.178.69:8081')
          .setValue(settings.serverUrl)
          .onChange(async (value) => {
            (this.plugin as any).settings.serverUrl = value;
            await (this.plugin as any).saveSettings();
          })
      );

    // Vault Key
    new Setting(containerEl)
      .setName('Vault Key')
      .setDesc('Shared secret matching the server (check ~/.config/obsidian-sync/environment)')
      .addText((text) =>
        text
          .setPlaceholder('dd90a3b00ad5598d...')
          .setValue(settings.vaultKey)
          .onChange(async (value) => {
            (this.plugin as any).settings.vaultKey = value;
            await (this.plugin as any).saveSettings();
          })
      );

    // Device Name
    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('Friendly label for this device')
      .addText((text) =>
        text
          .setPlaceholder('pixelbeast')
          .setValue(settings.deviceName)
          .onChange(async (value) => {
            (this.plugin as any).settings.deviceName = value;
            await (this.plugin as any).saveSettings();
          })
      );

    // Max Binary Size (in MB)
    new Setting(containerEl)
      .setName('Max Binary Size (MB)')
      .setDesc('Skip syncing binary files larger than this on mobile')
      .addText((text) =>
        text
          .setPlaceholder('20')
          .setValue(String(Math.round(settings.maxBinarySize / (1024 * 1024))))
          .onChange(async (value) => {
            const num = parseInt(value) || 20;
            (this.plugin as any).settings.maxBinarySize = num * 1024 * 1024;
            await (this.plugin as any).saveSettings();
          })
      );

    // Exclude Patterns
    new Setting(containerEl)
      .setName('Exclude Patterns')
      .setDesc('Comma-separated patterns to exclude (e.g. .trash/**, *.tmp)')
      .addText((text) =>
        text
          .setPlaceholder('.obsidian/workspace.json, .trash/**')
          .setValue(settings.excludePatterns.join(', '))
          .onChange(async (value) => {
            (this.plugin as any).settings.excludePatterns = value
              .split(',')
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0);
            await (this.plugin as any).saveSettings();
          })
      );

    // CRDT GC Interval (in hours)
    new Setting(containerEl)
      .setName('CRDT GC Interval (hours)')
      .setDesc('How often to compact CRDT history (default: 24)')
      .addText((text) =>
        text
          .setPlaceholder('24')
          .setValue(String(Math.round(settings.crdtGcInterval / (1000 * 60 * 60))))
          .onChange(async (value) => {
            const num = parseInt(value) || 24;
            (this.plugin as any).settings.crdtGcInterval = num * 60 * 60 * 1000;
            await (this.plugin as any).saveSettings();
          })
      );

    containerEl.createEl('hr');

    // Connection status — reads from plugin state
    const statusDiv = containerEl.createDiv('sync-status');
    statusDiv.createEl('p', {
      text: 'Connection: ',
      cls: 'setting-item-name',
    });

    const statusSpan = statusDiv.createEl('span', {
      text: '—',
      cls: 'sync-status-indicator',
    });

    // Poll status every 2s
    setInterval(() => {
      const connected = (this.plugin as any)?.ws?.isConnected?.();
      statusSpan.textContent = connected ? 'Connected' : 'Disconnected';
      statusSpan.setAttr(
        'style',
        `color: ${connected ? 'var(--color-green)' : 'var(--color-orange)'}`
      );
    }, 2000);
  }
}