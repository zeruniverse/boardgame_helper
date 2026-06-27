declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module 'vue' {
  export interface ComponentCustomProperties {
    $message: typeof import('element-plus')['ElMessage'];
    $msgbox: typeof import('element-plus')['ElMessageBox'];
    $alert: typeof import('element-plus')['ElMessageBox']['alert'];
    $confirm: typeof import('element-plus')['ElMessageBox']['confirm'];
    $prompt: typeof import('element-plus')['ElMessageBox']['prompt'];
    $loading: typeof import('element-plus')['ElLoading']['service'];
  }
}