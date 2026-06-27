export let resetServerFunction: (() => Promise<boolean>) | null = null;

export function setResetServerFunction(fn: () => Promise<boolean>): void {
  resetServerFunction = fn;
}

export async function callResetServer(_password?: string): Promise<{ success: boolean; message: string }> {
  if (!resetServerFunction) {
    return { success: false, message: '重置功能未初始化' };
  }
  try {
    const result = await resetServerFunction();
    return { success: result, message: result ? '服务器重置成功' : '服务器重置失败' };
  } catch (error) {
    return { success: false, message: '重置过程中发生错误' };
  }
}
