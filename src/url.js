// URL building helpers. These translate the SDK's filter / sort /
// projection shapes into the api plugin's GET-form URL params, so a
// query passed to list() can equivalently land as a URL via urlFor().

export function joinUrl(base, path) {
    const normalised = base.endsWith('/') ? base.slice(0, -1) : base
    return normalised + path
}

// { name: 1, date: -1 } → "name,-date"
export function sortToParam(sort) {
    return Object.entries(sort)
        .map(([k, v]) => (Number(v) < 0 ? `-${k}` : k))
        .join(',')
}

// Walk a filter object and emit URL params using the api plugin's
// operator-suffix convention:
//
//   { 'meta.price': { $gt: 20 } }        → meta.price.$gt=20
//   { type: 'document' }                  → type=document
//   { 'meta.tags': { $in: ['a', 'b'] } } → meta.tags.$in=a,b
//
// Mutates the URLSearchParams passed in.
export function filterToParams(filter, params) {
    for (const [key, value] of Object.entries(filter)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [op, opVal] of Object.entries(value)) {
                const v = Array.isArray(opVal) ? opVal.join(',') : String(opVal)
                params.set(`${key}.${op}`, v)
            }
        } else if (Array.isArray(value)) {
            params.set(key, value.join(','))
        } else if (value != null) {
            params.set(key, String(value))
        }
    }
}
