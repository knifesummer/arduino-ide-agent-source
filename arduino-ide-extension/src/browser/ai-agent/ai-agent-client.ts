import { Emitter } from '@theia/core/lib/common/event';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application';
import { injectable } from '@theia/core/shared/inversify';
import {
  AiAgentEvent,
  AiAgentServiceClient,
  AiToolCall,
  AiToolResult,
} from '../../common/protocol/ai-agent-service';

@injectable()
export class AiAgentClientImpl
  implements AiAgentServiceClient, FrontendApplicationContribution
{
  private readonly eventEmitter = new Emitter<AiAgentEvent>();

  readonly onDidReceiveEvent = this.eventEmitter.event;
  toolHandler: ((call: AiToolCall) => Promise<AiToolResult>) | undefined;

  executeArduinoTool(call: AiToolCall): Promise<AiToolResult> {
    return this.toolHandler
      ? this.toolHandler(call)
      : Promise.resolve({ success: false, output: 'AI 助手面板未连接，未执行操作。' });
  }

  onStart(): void {
    // The service proxy calls setClient(this) after the DI graph is created.
  }

  notify(event: AiAgentEvent): void {
    this.eventEmitter.fire(event);
  }

  onAgentEvent(event: AiAgentEvent): void {
    this.notify(event);
  }

  dispose(): void {
    this.eventEmitter.dispose();
  }
}
