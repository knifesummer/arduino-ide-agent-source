export interface PendingArduinoAction {
  readonly name:
    | 'compile'
    | 'upload'
    | 'burn_bootloader'
    | 'open_serial_monitor'
    | 'read_serial'
    | 'clear_serial'
    | 'install_library';
  readonly input?: Record<string, unknown>;
  readonly label: string;
}

function commandText(content: string): string {
  return content
    .trim()
    .replace(/[。！!]+$/, '')
    .replace(/^(?:请|麻烦)?(?:你)?(?:帮我|替我)?(?:现在|立即|直接)?\s*/, '');
}

/** 网关不支持工具时，只兜底短而明确的单条命令，不能按出现的关键词执行。 */
export function detectArduinoAction(
  content: string
): PendingArduinoAction | undefined {
  if (content.length > 80 || /[\r\n`？?]/.test(content)) return undefined;
  const text = commandText(content);
  const suffix = '(?:一下|一次)?';
  const commands: readonly [string, PendingArduinoAction][] = [
    [
      `(?:编译|验证)(?:当前)?(?:草图|代码|程序)?${suffix}`,
      { name: 'compile', label: '编译草图' },
    ],
    [
      `(?:上传|烧录|刷入)(?:当前)?(?:草图|代码|程序)?(?:到(?:当前)?(?:开发板|板子))?${suffix}`,
      { name: 'upload', label: '上传草图' },
    ],
    [
      `(?:烧录|烧写)(?:当前开发板的?)?引导程序${suffix}`,
      { name: 'burn_bootloader', label: '烧录引导程序' },
    ],
    [
      `(?:打开|启动|连接)(?:当前)?串口监视器${suffix}`,
      { name: 'open_serial_monitor', label: '打开串口监视器' },
    ],
    [
      `(?:读取|查看|获取)(?:当前)?串口(?:输出|日志|消息)${suffix}`,
      { name: 'read_serial', label: '读取串口输出' },
    ],
    [
      `(?:清空|清除)(?:当前)?串口(?:输出|日志|消息|缓存)${suffix}`,
      { name: 'clear_serial', label: '清空串口缓存' },
    ],
    ['compile(?: current sketch)?', { name: 'compile', label: '编译草图' }],
    ['upload(?: current sketch)?', { name: 'upload', label: '上传草图' }],
    ['burn bootloader', { name: 'burn_bootloader', label: '烧录引导程序' }],
  ];
  return commands.find(([pattern]) =>
    new RegExp(`^${pattern}$`, 'i').test(text)
  )?.[1];
}

/** 只影响文本模式的自动应用；原生工具仍按明确任务和现有权限执行。 */
export function shouldAutoApplyArduinoCode(content: string): boolean {
  const text = commandText(content.replace(/```[\s\S]*?```/g, '')).trim();
  if (
    /^(?:如何|怎么|怎样|为什么|能否|是否|请问)/.test(text) ||
    /(?:不要|不许|不能|别|无需)(?:[^，。\n]{0,12})(?:修改|写入|覆盖|应用|改动)/.test(
      text
    ) ||
    /^(?:解释|说明|展示|介绍|举例|提供.*示例|只.*(?:代码|示例|解释))/.test(text)
  )
    return false;
  return (
    /^(?:修改|修复|改写|重写|优化|更新|替换|写入|完成)[\s\S]{0,80}(?:草图|程序|代码|文件|\.ino|bug|错误|问题)/i.test(
      text
    ) ||
    /^(?:编写|写|生成|创建|新建|实现|开发)[\s\S]{0,80}(?:程序|代码|草图|\.ino)/i.test(
      text
    ) ||
    /^(?:把|将)[\s\S]{0,80}(?:改为|改成|修改为|调整为|替换成|写入|改好)/.test(
      text
    )
  );
}
