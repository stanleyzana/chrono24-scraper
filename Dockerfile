# Image de base Node
FROM node:18-bullseye

# Dossier de travail
WORKDIR /app

# Copier uniquement les manifests pour optimiser le cache
COPY package*.json ./

# Installer les dépendances Node
RUN npm install

# Installer Playwright + navigateurs + deps système
# (installe Chromium et tout ce qu'il faut pour le lancer)
RUN npx -y playwright install --with-deps chromium

# Copier le reste du code
COPY . .

# Port d'écoute (Render injecte PORT, ton code fait process.env.PORT || 3001)
EXPOSE 3001

# Commande de démarrage
CMD ["npm", "start"]
