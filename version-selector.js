import VERSIONS from './versions.js'

const select = document.createElement('select')
select.className = 'title'
select.style = 'margin-left: 1em'

for (const version of VERSIONS) {
	const option = document.createElement('option')
	option.innerHTML = version
	select.appendChild(option)
}

// So hacky but it works for now.
const current = window.location.pathname.split('/').find((path) => VERSIONS.includes(path))
select.value = current

select.addEventListener('change', () => {
	const newPaths = window.location.pathname.replace(current, select.value)
	const newUrl = new URL(newPaths, window.location.origin)
	window.location.assign(newUrl)
})

const container = document.getElementById('tsd-search')
container.appendChild(select)
