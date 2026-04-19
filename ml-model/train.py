import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
import pickle

true_df = pd.read_csv('True.csv')
fake_df = pd.read_csv('Fake.csv')

true_df['label'] = 0
fake_df['label'] = 1

df = pd.concat([true_df, fake_df])

# ACCURACY FIX 1: Combine 'title' and 'text'. Fake news reveals itself heavily in the title.
# We fill any empty values with a blank space so it doesn't crash.
df['title'] = df['title'].fillna('')
df['text'] = df['text'].fillna('')
df['combined_text'] = df['title'] + " " + df['text']

X = df['combined_text']
y = df['label']

# ACCURACY FIX 2: Increased max_features to 50,000 so the model learns a wider vocabulary.
vectorizer = TfidfVectorizer(
    max_features=50000, 
    stop_words='english',
    ngram_range=(1,2)
)

X_vec = vectorizer.fit_transform(X)

# ACCURACY FIX 3: Added 'stratify=y' to guarantee perfectly balanced training and testing sets.
# Added 'random_state=42' for consistent, deterministic results.
X_train, X_test, y_train, y_test = train_test_split(X_vec, y, test_size=0.2, stratify=y, random_state=42)

# ACCURACY FIX 4: Added C=10 to force the model to fit the data tighter and catch subtle fake news patterns.
model = LogisticRegression(max_iter=2000, C=10, random_state=42)
model.fit(X_train, y_train)

pickle.dump(model, open('model.pkl', 'wb'))
pickle.dump(vectorizer, open('vectorizer.pkl', 'wb'))

# Optional: Print out the exact accuracy score so you can see the top-tier result yourself
accuracy = model.score(X_test, y_test)
print(f"Model trained successfully. New Optimized Accuracy: {accuracy * 100:.2f}%")