import './index.css';
import '@/assets/css/mobile.css';
import 'animate.css';
import 'remixicon/fonts/remixicon.css';

import { createApp } from 'vue';
import { createDiscreteApi } from 'naive-ui';

import i18n from '@/../i18n/renderer';
import router from '@/router';
import pinia from '@/store';

import App from './App.vue';
import directives from './directive';

const app = createApp(App);

// 在 app.mount() 之前创建全局 message API 并 provide 到 app 级别
// naive-ui 的 useMessage() 内部调用 inject('n-message-api', null)
// 如果 <n-message-provider> 没有找到，inject 返回 null 并抛出错误
// 通过 app.provide('n-message-api', ...) 可以让所有组件都能找到 message API
// 即使 <n-message-provider> 还未挂载或组件在异步 chunk 中
const { message, dialog, notification } = createDiscreteApi(
  ['message', 'dialog', 'notification']
);
app.provide('n-message-api', message);
app.provide('n-dialog-api', dialog);
app.provide('n-notification-api', notification);

Object.keys(directives).forEach((key: string) => {
  app.directive(key, directives[key as keyof typeof directives]);
});

app.use(pinia);
app.use(router);
app.use(i18n as any);
app.mount('#app');
