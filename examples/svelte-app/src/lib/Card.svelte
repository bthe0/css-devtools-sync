<script lang="ts">
  let { title }: { title: string } = $props();
</script>

<article class="card">
  <h3 class="card-title">{title}</h3>
  <p>Scoped style tier</p>
</article>

<style>
  .card {
    padding: 20px;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .card-title {
    color: #2563eb;
  }
</style>
