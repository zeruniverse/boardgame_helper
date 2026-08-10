import type { App } from 'vue';
import ElementPlus, { ElLoading, ElMessage, ElMessageBox } from 'element-plus';
import 'element-plus/dist/index.css';

/**
 * Register Element Plus through its official plugin entrypoint.
 *
 * Installing named component exports with app.use() is not reliable for every
 * compound component. In particular, ElRadioGroup/ElRadioButton can be left
 * unresolved because their companion components are registered internally by
 * the full plugin. The official installer also keeps future component usage
 * consistent across all game pages.
 */
export function registerElementPlus(app: App): void {
  app.use(ElementPlus);

  // Keep the legacy global helpers used by a few components.
  app.config.globalProperties.$message = ElMessage;
  app.config.globalProperties.$msgbox = ElMessageBox;
  app.config.globalProperties.$alert = ElMessageBox.alert;
  app.config.globalProperties.$confirm = ElMessageBox.confirm;
  app.config.globalProperties.$prompt = ElMessageBox.prompt;
  app.config.globalProperties.$loading = ElLoading.service;
}

export { ElLoading, ElMessage, ElMessageBox };
