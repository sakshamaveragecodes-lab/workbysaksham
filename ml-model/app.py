from flask import Flask, request, jsonify
import pickle

app = Flask(__name__)

model = pickle.load(open('model.pkl', 'rb'))
vectorizer = pickle.load(open('vectorizer.pkl', 'rb'))

@app.route('/predict', methods=['POST'])
def predict():
    data = request.get_json()
    text = data.get('text', '')

    if len(text) < 20:
        return jsonify({'label': 'Enter proper news', 'confidence': 0})

    vec = vectorizer.transform([text])
    pred = model.predict(vec)[0]

    return jsonify({
        'label': 'Fake' if pred == 1 else 'Real'
    })

app.run(port=8000)