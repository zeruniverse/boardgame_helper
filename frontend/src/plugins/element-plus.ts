// Element Plus 按需导入配置
// 替代全量导入，减少打包体积
// 如需添加新组件，请在此处注册

import type { App } from 'vue';

// 基础组件
import ElContainer from 'element-plus/es/components/container/index';
import ElHeader from 'element-plus/es/components/header/index';
import ElMain from 'element-plus/es/components/main/index';
import ElRow from 'element-plus/es/components/row/index';
import ElCol from 'element-plus/es/components/col/index';
import ElCard from 'element-plus/es/components/card/index';
import ElButton from 'element-plus/es/components/button/index';
import ElInput from 'element-plus/es/components/input/index';
import ElDialog from 'element-plus/es/components/dialog/index';
import ElForm from 'element-plus/es/components/form/index';
import ElFormItem from 'element-plus/es/components/form-item/index';
import ElSelect from 'element-plus/es/components/select/index';
import ElOption from 'element-plus/es/components/option/index';
import ElSwitch from 'element-plus/es/components/switch/index';
import ElDivider from 'element-plus/es/components/divider/index';
import ElSteps from 'element-plus/es/components/steps/index';
import ElStep from 'element-plus/es/components/step/index';
import ElAlert from 'element-plus/es/components/alert/index';
import ElRadioGroup from 'element-plus/es/components/radio-group/index';
import ElRadioButton from 'element-plus/es/components/radio-button/index';
import ElCollapse from 'element-plus/es/components/collapse/index';
import ElCollapseItem from 'element-plus/es/components/collapse-item/index';
import ElMessage from 'element-plus/es/components/message/index';
import ElMessageBox from 'element-plus/es/components/message-box/index';
import ElTag from 'element-plus/es/components/tag/index';
import ElTooltip from 'element-plus/es/components/tooltip/index';
import ElBadge from 'element-plus/es/components/badge/index';
import ElTable from 'element-plus/es/components/table/index';
import ElTableColumn from 'element-plus/es/components/table-column/index';
import ElIcon from 'element-plus/es/components/icon/index';
import ElLoading from 'element-plus/es/components/loading/index';
import ElPopover from 'element-plus/es/components/popover/index';
import ElCheckbox from 'element-plus/es/components/checkbox/index';
import ElCheckboxGroup from 'element-plus/es/components/checkbox-group/index';
import ElSlider from 'element-plus/es/components/slider/index';
import ElProgress from 'element-plus/es/components/progress/index';

// 导入组件样式
import 'element-plus/es/components/container/style/css';
import 'element-plus/es/components/header/style/css';
import 'element-plus/es/components/main/style/css';
import 'element-plus/es/components/row/style/css';
import 'element-plus/es/components/col/style/css';
import 'element-plus/es/components/card/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/divider/style/css';
import 'element-plus/es/components/steps/style/css';
import 'element-plus/es/components/step/style/css';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/radio-group/style/css';
import 'element-plus/es/components/radio-button/style/css';
import 'element-plus/es/components/collapse/style/css';
import 'element-plus/es/components/collapse-item/style/css';
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/tooltip/style/css';
import 'element-plus/es/components/badge/style/css';
import 'element-plus/es/components/table/style/css';
import 'element-plus/es/components/table-column/style/css';
import 'element-plus/es/components/icon/style/css';
import 'element-plus/es/components/loading/style/css';
import 'element-plus/es/components/popover/style/css';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/checkbox-group/style/css';
import 'element-plus/es/components/slider/style/css';
import 'element-plus/es/components/progress/style/css';

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
