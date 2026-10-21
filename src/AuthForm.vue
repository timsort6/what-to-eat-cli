<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { authenticate } from './api'
import { messageFrom } from './protocol'
import type { User } from './protocol'

defineProps<{ notice: string }>()
const emit = defineEmits<{ authenticated: [user: User] }>()
const isRegister = ref(false)
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const controller = new AbortController()
onUnmounted(() => controller.abort())

function toggle(): void {
  isRegister.value = !isRegister.value
  error.value = ''
  password.value = ''
}

async function submit(): Promise<void> {
  if (busy.value) return
  error.value = ''
  busy.value = true
  const registering = isRegister.value
  try {
    const data = await authenticate({ username: username.value.trim(), password: password.value, register: registering }, controller.signal)
    password.value = ''
    emit('authenticated', data.user)
  } catch (failure) {
    if (!controller.signal.aborted) {
      error.value = messageFrom(failure)
      if (registering) error.value += '；若账号已注册成功，请切换到登录重试。'
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="auth-layout">
    <form class="panel auth-panel" @submit.prevent="submit">
      <div class="panel-heading">
        <div><p class="eyebrow">附近美食推荐</p><h2>{{ isRegister ? '创建账号' : '登录食见' }}</h2></div>
        <button class="text-button" type="button" :disabled="busy" @click="toggle">{{ isRegister ? '返回登录' : '注册账号' }}</button>
      </div>
      <p class="auth-description">登录后选择位置，输入今天的美食需求。</p>
      <label class="field"><span>用户名</span><input v-model="username" required :disabled="busy" autocomplete="username" :pattern="isRegister ? '[a-zA-Z0-9_]+' : undefined" placeholder="英文、数字或下划线" /></label>
      <label class="field"><span>密码</span><input v-model="password" required :disabled="busy" type="password" :autocomplete="isRegister ? 'new-password' : 'current-password'" aria-describedby="password-hint" /></label>
      <p id="password-hint" class="form-note">{{ isRegister ? '建议使用大小写字母、数字和符号组合，密码强度以服务器校验为准。' : '凭证保留在本次标签页会话中。' }}</p>
      <p v-if="error" class="message error-message" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="message" role="status">{{ notice }}</p>
      <button class="button button-primary wide-button" type="submit" :disabled="busy">{{ busy ? '处理中…' : isRegister ? '注册并登录' : '登录' }}</button>
    </form>
  </section>
</template>
