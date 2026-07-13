<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <article :class="$style.card">
    <h3 :class="$style.title">{{ title }}</h3>
    <p>CSS module style tier</p>
  </article>
</template>

<style module>
.card {
  padding: 20px;
  border-radius: 8px;
  background: #fef3c7;
  border: 1px solid #f59e0b;
}

.title {
  color: #b45309;
  margin: 0 0 8px;
}
</style>
