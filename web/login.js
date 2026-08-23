const form = document.querySelector('#login-form');
const password = document.querySelector('#login-password');
const error = document.querySelector('#login-error');

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({password: password.value}),
    });
    if (!response.ok) throw new Error('Неверный пароль');
    location.replace('/');
  } catch (reason) {
    error.textContent = reason.message || 'Не удалось выполнить вход';
    password.select();
  } finally {
    button.disabled = false;
  }
});
