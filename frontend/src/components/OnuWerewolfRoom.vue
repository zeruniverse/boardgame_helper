<template><div>一夜狼人房间 {{ roomId }}</div></template><script setup>import { useRoute } from 'vue-router'; const route = useRoute(); const roomId = route.params.id;</script>
