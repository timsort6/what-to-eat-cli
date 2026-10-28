<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import AuthForm from './AuthForm.vue'
import LocationPanel from './LocationPanel.vue'
import ChatPanel from './ChatPanel.vue'
import { clearSession, getToken, me } from './api'
import { ApiError, messageFrom } from './protocol'
import type { LocationChoice, User } from './protocol'

const user = ref<User | null>(null)
const location = ref<LocationChoice | null>(null)
const restoring = ref(false)
const notice = ref('')
const session = shallowRef(new AbortController())

function logout(message = '已退出登录'): void {
  session.value.abort()
  session.value = new AbortController()
  clearSession()
  user.value = null
  location.value = null
  notice.value = message
}

function authenticated(value: User): void {
  session.value.abort()
  session.value = new AbortController()
  location.value = null
  notice.value = ''
  user.value = value
}

onMounted(async () => {
  restoring.value = true
  try {
    if (getToken()) user.value = await me(session.value.signal)
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 401) logout('登录已过期，请重新登录')
    else notice.value = `恢复会话失败：${messageFrom(failure)}。可以重新登录。`
  } finally {
    restoring.value = false
  }
})
onUnmounted(() => session.value.abort())
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-mark" aria-hidden="true">食</div>
      <div><p class="eyebrow">附近美食推荐</p><h1>食见</h1></div>
      <div v-if="user" class="account-area"><span class="account-name" :title="user.username">{{ user.username }}</span><button class="button button-quiet" type="button" @click="logout()">退出登录</button></div>
    </header>
    <p v-if="restoring" class="message" role="status">正在恢复登录会话…</p>
    <AuthForm v-else-if="!user" :notice="notice" @authenticated="authenticated" />
    <section v-else :key="user.id" class="workspace">
      <LocationPanel :signal="session.signal" @select="location = $event" @expired="logout('登录已过期，请重新登录')" />
      <ChatPanel :signal="session.signal" :location="location" @expired="logout('登录已过期，请重新登录')" />
    </section>
  </main>
</template>
