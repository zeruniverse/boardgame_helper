// Element Plus 按需导入配置
// 使用标准入口导入，兼容 Element Plus 2.14.1

import type { App } from 'vue';

// 基础组件 - 从主包导入
import {
  ElContainer,
  ElHeader,
  ElMain,
  ElRow,
  ElCol,
  ElCard,
  ElButton,
  ElInput,
  ElDialog,
  ElForm,
  ElFormItem,
  ElSelect,
  ElOption,
  ElSwitch,
  ElDivider,
  ElSteps,
  ElStep,
  ElAlert,
  ElRadioGroup,
  ElRadioButton,
  ElCollapse,
  ElCollapseItem,
  ElMessage,
  ElMessageBox,
  ElTag,
  ElTooltip,
  ElBadge,
  ElTable,
  ElTableColumn,
  ElIcon,
  ElLoading,
  ElPopover,
  ElCheckbox,
  ElCheckboxGroup,
  ElSlider,
  ElProgress,
  ElBacktop
} from 'element-plus';

// 导入组件样式
import 'element-plus/dist/index.css';

// 组件列表
const components = [
  ElContainer, ElHeader, ElMain,
  ElRow, ElCol,
  ElCard,
  ElButton,
  ElInput,
  ElDialog,
  ElForm, ElFormItem,
  ElSelect, ElOption,
  ElSwitch,
  ElDivider,
  ElSteps, ElStep,
  ElAlert,
  ElRadioGroup, ElRadioButton,
  ElCollapse, ElCollapseItem,
  ElTag,
  ElTooltip,
  ElBadge,
  ElTable, ElTableColumn,
  ElIcon,
  ElPopover,
  ElCheckbox,
  ElCheckboxGroup,
  ElSlider,
  ElProgress,
  ElBacktop,
];

export function registerElementPlus(app: App) {
  // 注册所有组件
  components.forEach((component: any) => {
    app.use(component);
  });

  // 注册指令
  app.use(ElLoading);

  // 注册全局属性（ElMessage, ElMessageBox, ElLoading）
  app.config.globalProperties.$message = ElMessage;
  app.config.globalProperties.$msgbox = ElMessageBox;
  app.config.globalProperties.$alert = ElMessageBox.alert;
  app.config.globalProperties.$confirm = ElMessageBox.confirm;
  app.config.globalProperties.$prompt = ElMessageBox.prompt;
  app.config.globalProperties.$loading = ElLoading.service;
}

// 导出命令式API供直接使用
export { ElMessage, ElMessageBox, ElLoading };
