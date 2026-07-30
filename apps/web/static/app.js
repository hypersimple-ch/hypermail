import { activateWaitingUpdate, registerPwaWorker } from '/pwa/registration.js';
import { initialPwaState } from '/pwa/state.js';

const connection = document.querySelector('#connection');
const installButton = document.querySelector('#install');
const updateButton = document.querySelector('#update');
let deferredInstall;
let registration;
let reloadingForController = false;

const showConnection = () => {
  const online = navigator.onLine;
  connection.textContent = online ? 'Online' : 'Offline — reconnect to use Hypermail.';
  document.documentElement.dataset.connectivity = online ? 'online' : 'offline';
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const applyMotionPreference = () => { document.documentElement.dataset.reducedMotion = reducedMotion.matches ? 'true' : 'false'; };
showConnection();
applyMotionPreference();
addEventListener('online', showConnection);
addEventListener('offline', showConnection);
reducedMotion.addEventListener('change', applyMotionPreference);

addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  if (!deferredInstall) return;
  installButton.disabled = true;
  await deferredInstall.prompt();
  deferredInstall = undefined;
  installButton.hidden = true;
});
addEventListener('appinstalled', () => { deferredInstall = undefined; installButton.hidden = true; });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadingForController) {
      reloadingForController = true;
      location.reload();
    }
  });
  registerPwaWorker(navigator.serviceWorker, (state) => {
    if (state.update === 'available') updateButton.hidden = false;
  }, initialPwaState).then((value) => { registration = value; }).catch(() => {
    connection.textContent = 'Offline — Hypermail could not prepare its connectivity shell.';
  });
}

updateButton.addEventListener('click', () => {
  if (!registration) return;
  updateButton.disabled = true;
  activateWaitingUpdate(registration);
});
