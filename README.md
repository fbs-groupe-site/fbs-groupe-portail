# Portail FBS GROUPE

Application web responsive du centre de formation FBS GROUPE SARLU, déployée séparément du site vitrine.

## Déploiement GitHub Pages

Le workflow `.github/workflows/pages.yml` publie le contenu du dépôt à chaque modification sur `main`. Dans les paramètres du dépôt, choisir **Settings → Pages → GitHub Actions** comme source de publication.

Après le premier déploiement, ajouter l’adresse GitHub Pages obtenue aux URL autorisées dans **Supabase → Authentication → URL Configuration** (Site URL et Redirect URLs). Le portail utilise l’URL, les clés publishable et les politiques RLS du projet Supabase; aucune clé `service_role` ni donnée de carte bancaire ne doit être ajoutée au dépôt.

## Base de données

`supabase-schema.sql` contient le schéma Supabase idempotent, les politiques RLS et le catalogue initial. Les paiements et documents sont privés; les fournisseurs d’e-mail et de SMS restent à configurer dans Supabase et dans les services du centre.
