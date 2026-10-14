/**
 * 常用 Arduino 工程的起步提示。
 * 模板只负责填充对话框，不会自动修改草图或执行硬件操作。
 */
export interface AiAgentTemplate {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly prompt: string;
}

export const AI_AGENT_TEMPLATES: readonly AiAgentTemplate[] = [
  {
    id: 'button-led',
    title: '按钮 + LED',
    summary: '消抖、非阻塞闪烁',
    prompt:
      '请为 Arduino UNO 编写一个按钮控制 LED 的完整程序：按钮接 D2，LED 接 D8，使用内部上拉；按下后 LED 闪烁 3 次。要求使用 millis() 实现非阻塞消抖和时序，给出接线表、完整 .ino 代码以及验证步骤。',
  },
  {
    id: 'buzzer',
    title: '蜂鸣器提醒',
    summary: '按键提示音',
    prompt:
      '请为 Arduino UNO 编写一个蜂鸣器提醒程序：按钮接 D2（内部上拉），有源蜂鸣器接 D9；每次按下只响一次并进行消抖。请兼容有源和无源蜂鸣器，说明切换方式，给出完整 .ino 代码、接线和测试步骤。',
  },
  {
    id: 'dht',
    title: '温湿度监测',
    summary: 'DHT22 + 串口输出',
    prompt:
      '请为 Arduino UNO 编写 DHT22 温湿度监测程序：数据线接 D4，每 2 秒读取一次并通过 Serial 输出温度、湿度和异常信息。请列出需要安装的库、接线（含上拉电阻建议）、完整 .ino 代码和串口监视器验证步骤。',
  },
  {
    id: 'servo',
    title: '舵机控制',
    summary: '电位器平滑转动',
    prompt:
      '请为 Arduino UNO 编写 SG90 舵机控制程序：舵机信号线接 D9，电位器中间端接 A0；将模拟值平滑映射到 0~180 度，避免阻塞主循环。请说明独立供电和共地注意事项，给出完整 .ino 代码和验证步骤。',
  },
  {
    id: 'serial-sensor',
    title: '串口传感器',
    summary: 'UART 数据帧解析',
    prompt:
      '请为 Arduino UNO 设计一个串口传感器读取示例：传感器通过软串口 TX/RX 发送以换行结尾的文本数据；程序应非阻塞接收、校验一行数据并打印解析结果，同时避免 String 内存碎片。请给出接线、依赖库、完整 .ino 代码和测试方法。',
  },
  {
    id: 'light',
    title: '光敏自动灯',
    summary: '阈值 + 回差控制',
    prompt:
      '请为 Arduino UNO 编写光敏电阻自动灯程序：光敏分压接 A0，LED 或继电器控制端接 D8；根据环境光自动开关，并加入可调阈值和回差避免临界点抖动。请给出接线、完整 .ino 代码、参数说明和校准步骤。',
  },
];
