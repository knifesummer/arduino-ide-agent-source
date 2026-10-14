import { injectable } from '@theia/core/shared/inversify';
import {
  AbstractViewContribution,
  ApplicationShell,
} from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { MenuModelRegistry } from '@theia/core/lib/common/menu';
import { ArduinoMenus } from '../menu/arduino-menus';
import { AiAgentWidget } from './ai-agent-widget';

@injectable()
export class AiAgentViewContribution extends AbstractViewContribution<AiAgentWidget> {
  static readonly TOGGLE_COMMAND = 'arduino-ai-agent.toggle';

  /**
   * The Agent is a docked workbench view, so it must be checked after both the
   * default layout and a persisted layout have been applied.  The promise
   * guard also prevents two startup contributions from creating the widget
   * twice while the shell is still processing pending updates.
   */
  private ensurePanelPromise: Promise<void> | undefined;
  private panelEnsured = false;

  constructor() {
    super({
      widgetId: AiAgentWidget.ID,
      widgetName: AiAgentWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 1,
      },
      toggleCommandId: AiAgentViewContribution.TOGGLE_COMMAND,
      toggleKeybinding: 'CtrlCmd+Alt+A',
    });
  }

  override get defaultViewOptions(): ApplicationShell.WidgetOptions {
    return {
      ...super.defaultViewOptions,
      area: 'right',
      rank: 1,
    };
  }

  async initializeLayout(): Promise<void> {
    await this.ensureAgentPanel();
  }

  async onDidInitializeLayout(): Promise<void> {
    // The persisted Theia layout is applied before this callback. If the
    // default layout already opened the Agent, only inspect its area here;
    // rerun the full placement routine when an old layout put it elsewhere.
    const widget = this.tryGetWidget();
    if (
      this.panelEnsured &&
      widget &&
      this.shell.getAreaFor(widget) === 'right'
    ) {
      return;
    }
    await this.ensureAgentPanel();
  }

  private ensureAgentPanel(): Promise<void> {
    if (this.panelEnsured) {
      return Promise.resolve();
    }
    if (!this.ensurePanelPromise) {
      this.ensurePanelPromise = this.ensureAgentPanelInternal()
        .then(() => {
          this.panelEnsured = true;
        })
        .finally(() => {
          this.ensurePanelPromise = undefined;
        });
    }
    return this.ensurePanelPromise;
  }

  private async ensureAgentPanelInternal(): Promise<void> {
    const widget = await this.widget;
    const currentArea = this.shell.getAreaFor(widget);

    // A stale layout can contain an older Agent widget in the editor or a
    // secondary window. Recreate it in the dedicated right dock in that case.
    if (currentArea && currentArea !== 'right') {
      await this.closeView();
    }

    await this.openView({
      area: 'right',
      rank: 1,
      activate: false,
      reveal: true,
    });
    this.shell.expandPanel('right');
    await this.shell.pendingUpdates;

    // Theia's default right panel is intentionally narrow. Give the chat a
    // readable starting width while preserving a user's manually resized
    // panel across subsequent launches.
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve())
    );
    const rightPanel = this.shell.rightPanelHandler.container.node;
    if (rightPanel.offsetWidth > 0 && rightPanel.offsetWidth < 360) {
      this.shell.resize(
        Math.min(
          560,
          Math.max(380, Math.floor(this.shell.node.clientWidth * 0.4))
        ),
        'right'
      );
    }
  }

  override registerMenus(menus: MenuModelRegistry): void {
    if (this.toggleCommand) {
      menus.registerMenuAction(ArduinoMenus.TOOLS__MAIN_GROUP, {
        commandId: this.toggleCommand.id,
        label: AiAgentWidget.LABEL,
        order: '4',
      });
    }
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
  }
}
