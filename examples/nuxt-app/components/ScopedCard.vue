<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="card">
    <h2>{{ title }}</h2>
  </div>
</template>

<style scoped>
.card {
  padding: 20px;
  border-radius: 8px;
}
</style>
