// Runtime behaviour the mirror must reproduce offline.
fetch('/api/data.json').then(function (r) { return r.json(); }).then(function (d) {
  var ul = document.getElementById('dynamic-list');
  ul.innerHTML = d.items.map(function (i) { return '<li>' + i + '</li>'; }).join('');
  var img = document.createElement('img');
  img.src = '/img/dynamic.png';
  img.alt = 'Dynamically inserted';
  img.id = 'dyn-img';
  document.querySelector('main').appendChild(img);
  var s = document.createElement('script');
  s.src = '/js/chunk.js';
  document.head.appendChild(s);
});
var xhr = new XMLHttpRequest();
xhr.open('GET', '/api/xhr.json');
xhr.onload = function () { document.body.setAttribute('data-xhr', JSON.parse(xhr.responseText).ok ? 'yes' : 'no'); };
xhr.send();
document.querySelectorAll('img.lazy').forEach(function (img) { img.setAttribute('src', img.getAttribute('data-src')); });
