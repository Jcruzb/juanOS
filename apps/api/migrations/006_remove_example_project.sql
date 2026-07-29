UPDATE projects
SET is_active = false, updated_at = now()
WHERE slug = 'example'
  AND repository_url = 'https://github.com/example/example.git'
  AND is_juanos = false;
