const form = document.querySelector('#login-form');
const password = document.querySelector('#login-password');
const error = document.querySelector('#login-error');
const i18n = globalThis.OrchestratorI18n;
const language = i18n?.getLanguage() || 'ru';
i18n?.translateDocument(language);

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
    if (!response.ok) throw new Error(i18n?.pick('Неверный пароль', 'Incorrect password', language) || 'Неверный пароль');
    location.replace('/');
  } catch (reason) {
    error.textContent = reason.message || i18n?.pick('Не удалось выполнить вход', 'Unable to sign in', language) || 'Не удалось выполнить вход';
    password.select();
  } finally {
    button.disabled = false;
  }
});
